// Renders the nightly live check's reports (report.json files written by
// `live-check.mjs run`) as the markdown body of a GitHub issue comment.
//
//   node scripts/live-check-report.mjs RUN_URL TAG [TAG ...]
//
// A TAG whose report is missing means the run died before it finished; the
// body then says so and points at the workflow log. Output stays under the
// issue-comment limit.
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LIMIT = 60_000;

/** The parts of a report that explain a failure; the full status document is left out. */
function summary(report) {
  return {
    objective: report.objective,
    pass: report.pass,
    launches: report.launches.map(
      ({ launch, point, code, signal, killed }) => ({
        launch,
        point,
        code,
        signal,
        killed,
      }),
    ),
    unreached: report.unreached,
    checks: report.github.checks,
    issuesPerItem: report.github.issuesPerItem,
    prsPerBranch: report.github.prsPerBranch,
    duplicateComments: report.github.duplicateComments,
    lastOutput: report.launches.at(-1)?.tail,
  };
}

/** `reports` maps a tag to its parsed report, or to undefined when it is missing. */
export function renderReport(runUrl, reports) {
  const lines = [`Nightly live check run: ${runUrl}`, ""];
  for (const [tag, report] of Object.entries(reports)) {
    if (!report) {
      lines.push(
        `**${tag}**: no report; the run ended before it finished. See the workflow log.`,
        "",
      );
      continue;
    }
    const failed = Object.entries(report.github.checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);
    lines.push(
      `**${tag}** (${report.delivery}, ${report.worker} worker, Objective #${report.objective}): ${report.pass ? "pass" : "FAIL"}`,
    );
    if (!report.pass)
      lines.push(
        failed.length
          ? `Failed GitHub checks: ${failed.join(", ")}`
          : "GitHub counts passed; the run itself did not end cleanly.",
        report.unreached.length
          ? `Kill points never reached: ${report.unreached.join(", ")}`
          : "",
      );
    lines.push(
      "",
      "<details><summary>report</summary>",
      "",
      "```json",
      JSON.stringify(summary(report), null, 2),
      "```",
      "",
      "</details>",
      "",
    );
  }
  const text = lines.join("\n");
  return text.length <= LIMIT
    ? text
    : `${text.slice(0, LIMIT)}\n\n(truncated; the workflow artifact holds the full reports)`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [runUrl, ...tags] = process.argv.slice(2);
  if (!runUrl || !tags.length)
    throw new Error("usage: live-check-report.mjs RUN_URL TAG [TAG ...]");
  const reports = Object.fromEntries(
    tags.map((tag) => {
      const path = join(tmpdir(), `live-check-${tag}`, "report.json");
      return [
        tag,
        existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined,
      ];
    }),
  );
  console.log(renderReport(runUrl, reports));
}
