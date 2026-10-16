import { displayDateTime } from "./display-time.js";
import { attemptKindLabel } from "./repair-policy.js";
import { PROGRESS_ITEM_ID, progressMarker } from "./github-progress-state.js";
import {
  itemAttempt,
  summarizeStatus,
  type StatusView,
} from "./status-summary.js";

/** Text explicitly cleared for the target issue's existing disclosure scope. */
export interface GitHubProgressDecision {
  question: string;
  recommendation: string;
  consequences: string;
  binding: string;
}

/** The Objective's public status: what its live comment shows and its notifications summarize. */
export interface ObjectiveStatusInput {
  repository: string;
  view: StatusView;
  /** Cleared text only; never copy arbitrary diagnostics or model logs here. */
  nextAction: string;
  blockers: string[];
  decisions: GitHubProgressDecision[];
}

export interface RunDetailsInput {
  runId: string;
  configDigest: string;
  decisions: GitHubProgressDecision[];
  /** Fully filled identities; the operator changes only answer and reason. */
  planDecisionTemplate?: import("./github-plan-decisions.js").PlanDecisionEnvelope;
}

export interface GitHubProgressInput
  extends ObjectiveStatusInput,
    RunDetailsInput {
  snapshotId: string;
  /** The observation time belongs to the persisted snapshot, not this render. */
  observedAt: string;
  preparedAt: string;
}

const markdown = (text: string): string =>
  text.replace(/[\\`*_{}[\]()<>#!|]/g, "\\$&").replace(/@/g, "@\u200b");
const compact = (text: string): string =>
  markdown(text.replace(/\s+/g, " ").trim());
const issueLink = (repository: string, number: number): string =>
  `[#${number}](https://github.com/${repository}/issues/${number})`;
const pullLink = (repository: string, number: number): string =>
  `[#${number}](https://github.com/${repository}/pull/${number})`;
const ACTIVE_STEPS = [
  "execute",
  "validate",
  "approve-asset",
  "approve-result",
  "deliver",
];

/**
 * The Objective's headline, delivered and active Work Items, next action,
 * blockers and decisions, from the existing status derivation. No I/O and no
 * decision, recovery, freshness or publication authority. Unknown controller
 * ownership remains unknown; accepted means status done. `items: false` keeps
 * only the delivered count, for a short notification.
 */
export function objectiveStatusLines(
  input: ObjectiveStatusInput,
  options: { items: boolean; activeNote?: (id: string) => string } = {
    items: true,
  },
): string[] {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(input.repository) ||
    !Number.isSafeInteger(input.view.objective) ||
    input.view.objective <= 0
  )
    throw new Error("GitHub status requires a verified Objective identity");
  if (input.blockers.length > 8 || input.decisions.length > 8)
    throw new Error("GitHub status exceeds the bounded question/blocker count");
  const cleared = [
    input.nextAction,
    ...input.blockers,
    ...input.decisions.flatMap((decision) => Object.values(decision)),
  ];
  if (cleared.some((text) => !text.trim() || Buffer.byteLength(text) > 2_000))
    throw new Error("GitHub status requires complete bounded public text");
  const { phase } = summarizeStatus(input.view);
  const work = "work" in input.view ? input.view.work : [];
  const done = work.filter((item) => item.status === "done");
  const active = work.filter((item) =>
    ["running", "published", "merging", "waiting"].includes(item.status),
  );
  // Controller state is worth a line only when no controller is running.
  const ownership =
    input.view.runActive === false
      ? "No controller running"
      : input.view.runActive === undefined
        ? "Controller state unknown"
        : undefined;
  return [
    `### Factory · ${issueLink(input.repository, input.view.objective)} · ${compact(phase)}`,
    ...(ownership ? [ownership] : []),
    ...(work.length && !options.items
      ? ["", `**Delivered:** ${done.length}/${work.length}`]
      : []),
    ...(work.length && options.items
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
    ...(active.length && options.items
      ? [
          "",
          "**Active:**",
          ...active
            .slice(0, 12)
            .map(
              (item) =>
                `- ${compact(item.id)} · ${compact(item.status)}${item.step && ACTIVE_STEPS.includes(item.step) ? ` (${item.step})` : ""}${itemAttempt(item)}${item.pullRequest ? ` · ${pullLink(input.repository, item.pullRequest)}` : ""}${options.activeNote?.(item.id) ?? ""}`,
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
    ...decisionLines(input.decisions),
  ];
}

function decisionLines(decisions: GitHubProgressDecision[]): string[] {
  return decisions.length
    ? [
        "",
        "**Decisions needed:**",
        ...decisions.flatMap((decision, index) => [
          `${index + 1}. ${compact(decision.question)}`,
          `   Recommendation: ${compact(decision.recommendation)}`,
          `   Consequences: ${compact(decision.consequences)}`,
        ]),
      ]
    : [];
}

/** The collapsed run identity, decision bindings and the plan-decision template. */
export function runDetailsLines(input: RunDetailsInput): string[] {
  if (
    !/^[a-zA-Z0-9-]{1,128}$/.test(input.runId) ||
    !/^[a-f0-9]{64}$/.test(input.configDigest)
  )
    throw new Error("GitHub status requires a verified run identity");
  return [
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
}

/**
 * A new comment on the Objective, posted only when it needs a notification: a
 * human decision, or completion, failure or cancellation. The live status
 * comment carries every other change.
 */
export function renderObjectiveNotification(
  input: GitHubProgressInput,
): string {
  if (
    !/^[a-f0-9-]{36}$/.test(input.snapshotId) ||
    [input.observedAt, input.preparedAt].some((at) =>
      Number.isNaN(Date.parse(at)),
    ) ||
    Date.parse(input.observedAt) > Date.parse(input.preparedAt)
  )
    throw new Error(
      "GitHub progress requires verified identity and observation times",
    );
  const lines = [
    progressMarker({
      objective: input.view.objective,
      runId: input.runId,
      snapshotId: input.snapshotId,
    }),
    ...objectiveStatusLines(input, { items: false }),
    "",
    `<sub>Observed ${displayDateTime(input.observedAt)} · Factory keeps its Live status comment on this issue current</sub>`,
    "",
    ...runDetailsLines(input),
  ];
  const body = lines.join("\n");
  if (Buffer.byteLength(body) > 24_000)
    throw new Error("GitHub progress exceeds its publication byte bound");
  return body;
}

/** `attempt 2 (1a2b3c4d) · retry`, or `attempt 1a2b3c4d` without an ordinal. */
function attemptText(id: string, number?: number, kind?: string): string {
  const short = compact(id.slice(0, 8));
  if (!number) return `attempt ${short}`;
  const label = number > 1 && kind ? attemptKindLabel(kind) : undefined;
  return `attempt ${number} (${short})${label ? ` · ${label}` : ""}`;
}

/** One Work Item's public facts: structured fields only, never logs or exception text. */
export interface WorkItemFacts {
  status: import("./state.js").WorkStatus;
  step?: import("./state.js").WorkStep;
  /** The current attempt's identity. */
  attempt?: string;
  /** The current attempt's ordinal and how it started. */
  attemptNumber?: number;
  attemptKind?: string;
  pullRequest?: number;
  /** A provider outage the item's step is waiting out. */
  outage?: { step: string; retryAt?: string };
  /** The last failure's class, never its detail. */
  failure?: string;
  coordinator?: "running" | "paused" | "draining";
}

export interface WorkItemStatusInput extends WorkItemFacts {
  repository: string;
  objective: number;
  item: { id: string; issue: number };
  /** This item's pending human-owned criteria; cleared text only. */
  decisions: GitHubProgressDecision[];
}

export interface WorkItemProgressInput extends WorkItemStatusInput {
  runId: string;
  snapshotId: string;
  configDigest: string;
  observedAt: string;
}

const WORK_HEADLINE: Record<string, string> = {
  execute: "Executing",
  validate: "Validating",
  "approve-asset": "In review",
  "approve-result": "In review",
  deliver: "Delivering",
};

/** A Work Item's headline and structured facts for its own issue; no I/O and no authority. */
export function workItemStatusLines(input: WorkItemStatusInput): string[] {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(input.repository) ||
    !Number.isSafeInteger(input.objective) ||
    input.objective <= 0 ||
    !PROGRESS_ITEM_ID.test(input.item.id) ||
    !Number.isSafeInteger(input.item.issue) ||
    input.item.issue <= 0 ||
    (input.outage?.retryAt !== undefined &&
      Number.isNaN(Date.parse(input.outage.retryAt)))
  )
    throw new Error("Work Item status requires a verified identity");
  if (
    input.decisions.length > 8 ||
    input.decisions
      .flatMap((decision) => Object.values(decision))
      .some((text) => !text.trim() || Buffer.byteLength(text) > 2_000)
  )
    throw new Error("Work Item status requires complete bounded public text");
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
  return [
    `### ${headline} · ${compact(input.item.id)}`,
    `Objective ${issueLink(input.repository, input.objective)}${input.attempt ? ` · ${attemptText(input.attempt, input.attemptNumber, input.attemptKind)}` : ""}`,
    ...(input.outage
      ? [
          `Waiting out a provider outage in ${compact(input.outage.step)}${input.outage.retryAt ? `; next try after ${displayDateTime(input.outage.retryAt)}` : ""}.`,
        ]
      : []),
    ...(input.failure ? [`Last failure: ${compact(input.failure)}.`] : []),
    ...(input.pullRequest
      ? [`Pull request: ${pullLink(input.repository, input.pullRequest)}`]
      : []),
    ...(input.coordinator && input.coordinator !== "running"
      ? [`Factory is ${input.coordinator}.`]
      : []),
    ...decisionLines(input.decisions),
    ...(input.status === "waiting"
      ? [
          "",
          "**Next:** Handle the decision through the supported local Factory decision path.",
        ]
      : input.status === "failed"
        ? [
            "",
            "**Next:** Inspect local Factory status for the exact supported recovery.",
          ]
        : []),
  ];
}

/**
 * A new comment on a Work Item's issue, posted only when it needs a
 * notification: the item failed or waits for a human decision.
 */
export function renderWorkItemNotification(
  input: WorkItemProgressInput,
): string {
  if (
    !/^[a-f0-9-]{36}$/.test(input.snapshotId) ||
    Number.isNaN(Date.parse(input.observedAt))
  )
    throw new Error(
      "Work Item progress requires verified identity and observation times",
    );
  return [
    progressMarker({
      objective: input.objective,
      runId: input.runId,
      snapshotId: input.snapshotId,
      item: input.item.id,
    }),
    ...workItemStatusLines(input),
    "",
    `<sub>Observed ${displayDateTime(input.observedAt)} · Factory keeps its Live status comment on this issue current</sub>`,
    "",
    ...runDetailsLines(input),
  ].join("\n");
}
