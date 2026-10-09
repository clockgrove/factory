import { summarizeStatus, type StatusView } from "./status-summary.js";

/** Text explicitly cleared for the target issue's existing disclosure scope. */
export interface GitHubProgressDecision {
  question: string;
  recommendation: string;
  consequences: string;
  binding: string;
}

export interface GitHubProgressInput {
  repository: string;
  runId: string;
  snapshotId: string;
  configDigest: string;
  /** The observation time belongs to the persisted snapshot, not this render. */
  observedAt: string;
  preparedAt: string;
  view: StatusView;
  /** Cleared text only; never copy arbitrary diagnostics or model logs here. */
  nextAction: string;
  blockers: string[];
  decisions: GitHubProgressDecision[];
  /** Fully filled identities; the operator changes only answer and reason. */
  planDecisionTemplate?: import("./github-plan-decisions.js").PlanDecisionEnvelope;
}

const markdown = (text: string): string =>
  text.replace(/[\\`*_{}[\]()<>#!|]/g, "\\$&").replace(/@/g, "@\u200b");
const compact = (text: string): string =>
  markdown(text.replace(/\s+/g, " ").trim());
const issueLink = (repository: string, number: number): string =>
  `[#${number}](https://github.com/${repository}/issues/${number})`;
const pullLink = (repository: string, number: number): string =>
  `[#${number}](https://github.com/${repository}/pull/${number})`;

/**
 * A bounded presentation of the existing status derivation. This does no
 * I/O and creates no decision, recovery, freshness or publication authority.
 * Unknown controller ownership remains unknown; accepted means status done.
 */
export function renderGitHubProgress(input: GitHubProgressInput): string {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(input.repository) ||
    !Number.isSafeInteger(input.view.objective) ||
    input.view.objective <= 0 ||
    !/^[a-zA-Z0-9-]{1,128}$/.test(input.runId) ||
    !/^[a-f0-9-]{36}$/.test(input.snapshotId) ||
    !/^[a-f0-9]{64}$/.test(input.configDigest) ||
    [input.observedAt, input.preparedAt].some((at) =>
      Number.isNaN(Date.parse(at)),
    ) ||
    Date.parse(input.observedAt) > Date.parse(input.preparedAt)
  )
    throw new Error(
      "GitHub progress requires verified identity and observation times",
    );
  if (input.blockers.length > 8 || input.decisions.length > 8)
    throw new Error(
      "GitHub progress exceeds the bounded question/blocker count",
    );
  const cleared = [
    input.nextAction,
    ...input.blockers,
    ...input.decisions.flatMap((decision) => Object.values(decision)),
  ];
  if (cleared.some((text) => !text.trim() || Buffer.byteLength(text) > 2_000))
    throw new Error("GitHub progress requires complete bounded public text");
  const { phase } = summarizeStatus(input.view);
  const work = "work" in input.view ? input.view.work : [];
  const done = work.filter((item) => item.status === "done");
  const active = work.filter((item) =>
    ["running", "published", "merging"].includes(item.status),
  );
  const ownership =
    input.view.runActive === true
      ? "Controller observed active"
      : input.view.runActive === false
        ? "No active controller observed"
        : "Controller ownership unknown";
  const lines = [
    `<!-- factory:progress;objective=${input.view.objective};run=${input.runId};snapshot=${input.snapshotId} -->`,
    `### Factory progress · ${issueLink(input.repository, input.view.objective)}`,
    "",
    `**${compact(phase)}** · ${ownership}`,
    `Snapshot observed ${compact(input.observedAt)}; summary prepared ${compact(input.preparedAt)}. The GitHub comment timestamp records publication. This is a snapshot, not a live heartbeat.`,
    "",
    `**Accepted deliveries:** ${done.length}/${work.length} Work Items.`,
    ...done
      .slice(0, 12)
      .map(
        (item) =>
          `- ${compact(item.id)}${item.pullRequest ? ` · ${pullLink(input.repository, item.pullRequest)}` : ""}`,
      ),
    ...(done.length > 12 ? [`- ${done.length - 12} more accepted items.`] : []),
    "",
    `**Running or delivering:** ${active.length} Work Items.`,
    ...active
      .slice(0, 12)
      .map(
        (item) =>
          `- ${compact(item.id)} · ${compact(item.status)}${item.step && ["execute", "validate", "approve-asset", "approve-result", "deliver"].includes(item.step) ? ` (${item.step})` : ""}${item.pullRequest ? ` · ${pullLink(input.repository, item.pullRequest)}` : ""}`,
      ),
    ...(active.length > 12
      ? [`- ${active.length - 12} more active items.`]
      : []),
    "",
    `**Next:** ${compact(input.nextAction)}`,
    "",
    `**Blockers:** ${input.blockers.length ? "" : "None reported in this snapshot."}`,
    ...input.blockers.map((blocker) => `- ${compact(blocker)}`),
    "",
    `**Human decisions:** ${input.decisions.length ? "" : "None reported in this snapshot."}`,
    ...input.decisions.flatMap((decision, index) => [
      `${index + 1}. ${compact(decision.question)}`,
      `   Recommendation: ${compact(decision.recommendation)}`,
      `   Consequences: ${compact(decision.consequences)}`,
    ]),
    "",
    "<details><summary>Run and decision details</summary>",
    "",
    `Run ${compact(input.runId)} · configuration ${input.configDigest}`,
    ...input.decisions.map(
      (decision, index) =>
        `Decision ${index + 1} exact binding: ${compact(decision.binding)}`,
    ),
    ...(input.planDecisionTemplate
      ? [
          "",
          "To answer this planning question, copy this JSON into a new comment on this Objective issue. Change only answer and reason. Refusal and other actions use the local supported path.",
          "",
          "```json",
          JSON.stringify(input.planDecisionTemplate, null, 2),
          "```",
        ]
      : []),
    "",
    "</details>",
  ];
  const body = lines.join("\n");
  if (Buffer.byteLength(body) > 24_000)
    throw new Error("GitHub progress exceeds its publication byte bound");
  return body;
}
