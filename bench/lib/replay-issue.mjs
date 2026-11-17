// replay-issue.mjs: the issue body review-replay.mjs gives the reviewer for one record.

/**
 * An Objective's shown blocks as Markdown, each heading one level down. A heading whose text is exactly
 * `Acceptance` reads `Objective acceptance`: only the Work Item's own criteria are the issue's acceptance entries.
 */
export function objectiveMarkdown(blocks = []) {
  const lines = [];
  for (const b of blocks) {
    if (b.kind === "heading") {
      const text = String(b.text ?? "").trim().toLowerCase() === "acceptance" ? "Objective acceptance" : b.text;
      lines.push(`${"#".repeat(Math.min(6, (b.level ?? 2) + 1))} ${text}`);
    } else if (b.kind === "text") lines.push(b.text);
    else if (b.kind === "list" && Array.isArray(b.items)) lines.push(...b.items.map((i) => `- ${typeof i === "string" ? i : i.text ?? JSON.stringify(i)}`));
  }
  return lines.join("\n\n");
}

/**
 * The issue body for one record: the Objective's text, then the Work Item's criteria as numbered entries under the
 * exact `## Acceptance` heading Pendulum's issues use (logic.mjs acceptanceEntries), so the reviewer gets them by id.
 */
export function replayIssueBody({ blocks = [], item, criteria = [] }) {
  const acceptance = criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return `${objectiveMarkdown(blocks)}\n\n## Acceptance\n\nThis Work Item: ${item}.\n\n${acceptance}\n`;
}
