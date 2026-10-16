import { PROGRESS_ITEM_ID, progressMarker } from "./github-progress-state.js";
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
  // Controller state is worth a line only when no controller is running.
  const ownership =
    input.view.runActive === false
      ? "No controller running"
      : input.view.runActive === undefined
        ? "Controller state unknown"
        : undefined;
  const lines = [
    progressMarker({
      objective: input.view.objective,
      runId: input.runId,
      snapshotId: input.snapshotId,
    }),
    `### Factory · ${issueLink(input.repository, input.view.objective)} · ${compact(phase)}`,
    ...(ownership ? [ownership] : []),
    ...(work.length
      ? [
          "",
          `**Delivered:** ${done.length}/${work.length}`,
          ...done
            .slice(0, 12)
            .map(
              (item) =>
                `- ${compact(item.id)}${item.pullRequest ? ` · ${pullLink(input.repository, item.pullRequest)}` : ""}`,
            ),
          ...(done.length > 12 ? [`- ${done.length - 12} more`] : []),
        ]
      : []),
    ...(active.length
      ? [
          "",
          "**Active:**",
          ...active
            .slice(0, 12)
            .map(
              (item) =>
                `- ${compact(item.id)} · ${compact(item.status)}${item.step && ["execute", "validate", "approve-asset", "approve-result", "deliver"].includes(item.step) ? ` (${item.step})` : ""}${item.pullRequest ? ` · ${pullLink(input.repository, item.pullRequest)}` : ""}`,
            ),
          ...(active.length > 12 ? [`- ${active.length - 12} more`] : []),
        ]
      : []),
    "",
    `**Next:** ${compact(input.nextAction)}`,
    ...(input.blockers.length
      ? [
          "",
          "**Blockers:**",
          ...input.blockers.map((blocker) => `- ${compact(blocker)}`),
        ]
      : []),
    ...(input.decisions.length
      ? [
          "",
          "**Decisions needed:**",
          ...input.decisions.flatMap((decision, index) => [
            `${index + 1}. ${compact(decision.question)}`,
            `   Recommendation: ${compact(decision.recommendation)}`,
            `   Consequences: ${compact(decision.consequences)}`,
          ]),
        ]
      : []),
    "",
    `<sub>Observed ${shortTime(input.observedAt)}</sub>`,
    "",
    "<details><summary>Run details</summary>",
    "",
    `Run ${compact(input.runId)} · configuration ${input.configDigest}`,
    ...input.decisions.map(
      (decision, index) =>
        `Decision ${index + 1} binding: ${compact(decision.binding)}`,
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

/** A compact UTC time such as `2026-10-16 05:04Z`. */
function shortTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
}

/** One Work Item's public facts: structured fields only, never logs or exception text. */
export interface WorkItemProgressInput {
  repository: string;
  objective: number;
  item: { id: string; issue: number };
  runId: string;
  snapshotId: string;
  configDigest: string;
  observedAt: string;
  status: import("./state.js").WorkStatus;
  step?: import("./state.js").WorkStep;
  /** The current attempt's identity. */
  attempt?: string;
  pullRequest?: number;
  /** A provider outage the item's step is waiting out. */
  outage?: { step: string; retryAt?: string };
  /** The last failure's class, never its detail. */
  failure?: string;
  coordinator?: "running" | "paused" | "draining";
}

const WORK_HEADLINE: Record<string, string> = {
  execute: "Executing",
  validate: "Validating",
  "approve-asset": "In review",
  "approve-result": "In review",
  deliver: "Delivering",
};

/** A short transition comment for a Work Item's own issue; no I/O and no authority. */
export function renderWorkItemProgress(input: WorkItemProgressInput): string {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(input.repository) ||
    !Number.isSafeInteger(input.objective) ||
    input.objective <= 0 ||
    !PROGRESS_ITEM_ID.test(input.item.id) ||
    !Number.isSafeInteger(input.item.issue) ||
    input.item.issue <= 0 ||
    !/^[a-zA-Z0-9-]{1,128}$/.test(input.runId) ||
    !/^[a-f0-9-]{36}$/.test(input.snapshotId) ||
    !/^[a-f0-9]{64}$/.test(input.configDigest) ||
    Number.isNaN(Date.parse(input.observedAt)) ||
    (input.outage?.retryAt !== undefined &&
      Number.isNaN(Date.parse(input.outage.retryAt)))
  )
    throw new Error(
      "Work Item progress requires verified identity and observation times",
    );
  const headline =
    input.status === "running"
      ? (WORK_HEADLINE[input.step ?? ""] ?? "Running")
      : input.status === "published"
        ? "Pull request open"
        : input.status === "waiting"
          ? "Waiting for a human decision"
          : input.status === "done"
            ? "Accepted"
            : input.status === "failed"
              ? "Failed"
              : input.status === "cancelled"
                ? "Cancelled"
                : compact(input.status);
  const lines = [
    progressMarker({
      objective: input.objective,
      runId: input.runId,
      snapshotId: input.snapshotId,
      item: input.item.id,
    }),
    `### ${headline} · ${compact(input.item.id)}`,
    `Objective ${issueLink(input.repository, input.objective)}${input.attempt ? ` · attempt ${compact(input.attempt.slice(0, 8))}` : ""}`,
    ...(input.outage
      ? [
          `Waiting out a provider outage in ${compact(input.outage.step)}${input.outage.retryAt ? `; next try after ${compact(input.outage.retryAt)}` : ""}.`,
        ]
      : []),
    ...(input.failure ? [`Last failure: ${compact(input.failure)}.`] : []),
    ...(input.pullRequest
      ? [`Pull request: ${pullLink(input.repository, input.pullRequest)}`]
      : []),
    ...(input.coordinator && input.coordinator !== "running"
      ? [`Factory is ${input.coordinator}.`]
      : []),
    "",
    `<sub>Observed ${shortTime(input.observedAt)}</sub>`,
    "",
    "<details><summary>Run details</summary>",
    "",
    `Run ${compact(input.runId)} · configuration ${input.configDigest}`,
    "",
    "</details>",
  ];
  return lines.join("\n");
}
