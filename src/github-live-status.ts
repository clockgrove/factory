import { type FactoryConfig, githubProgressSettings } from "./config.js";
import type { GitHubGateway } from "./contracts.js";
import {
  type ModelActivity,
  objectiveModelActivity,
  redactDiagnosticDetail,
} from "./diagnostics.js";
import { displayDateTime } from "./display-time.js";
import { attachedFault } from "./fault.js";
import {
  type GitHubProgressDecision,
  type ObjectiveStatusInput,
  objectiveStatusLines,
  type RunDetailsInput,
  runDetailsLines,
  type WorkItemFacts,
  workItemStatusLines,
} from "./github-progress.js";
import {
  type LiveStatusRecord,
  liveStatusMarker,
  PROGRESS_ITEM_ID,
} from "./github-progress-state.js";
import {
  awaitCheckpointAdmission,
  isCheckpointAdmissionFailure,
} from "./recovery-checkpoint.js";
import { type ContinuationState, isExecutionState } from "./state.js";
import { type PlanningStepView, planningActivity } from "./status-summary.js";
import {
  activityLine,
  changesLine,
  formatTokens,
  type ItemActivity,
  itemActivities,
  PROGRESS_QUIET_MS,
  progressQuietMs,
  shortAge,
} from "./worker-activity.js";

type Args = {
  config: FactoryConfig;
  objective: number;
  github: GitHubGateway;
  save: () => void;
  secrets: string[];
};

/** How often an active comment is refreshed without a transition. */
const REFRESH_MS = 3 * 60_000;
const STALE_MS = 5 * 60_000;
const ACTIVE = ["running", "published", "waiting"];
const TERMINAL_PHASES = ["complete", "cancelled", "failed"];

/**
 * The last edit of each live comment in this process, by its transition digest.
 * Edits are idempotent and keep no state: after a restart the first tick edits once.
 */
const lastEdit = new Map<string, { digest: string; at: number }>();
/**
 * Failed edits or creates by transition digest, like the snapshot comments'
 * memo: a change retries at once; a repeat waits 3, 6, 12 … up to 60 minutes,
 * so a refused edit or an unknown create never spends delivery's request budget.
 */
const failedEdit = new Map<
  string,
  { digest: string; at: number; failures: number }
>();
const backoffMs = (failures: number) =>
  Math.min(REFRESH_MS * 2 ** (failures - 1), 60 * 60_000);
/** In-call tries of a final edit, which no later tick may follow. */
const FINAL_TRIES = 3;

interface LiveTarget {
  label: string;
  item?: { id: string; issue: number };
  issue: number;
  /** The public facts the comment shows; a change edits at once. */
  digest: string;
  active: boolean;
  read: (state: ContinuationState) => LiveStatusRecord | undefined;
  write: (state: ContinuationState, record: LiveStatusRecord) => void;
  /** The status lines, then the collapsed details below the update stamp. */
  render: (
    items: ItemActivity[],
    now: number,
  ) => { lines: string[]; details: string[] };
}

/** The status the projection derives once per tick, for the live comments. */
export interface LivePresentation {
  status: ObjectiveStatusInput;
  details: RunDetailsInput;
  /** Next action, blockers, decisions, template and control mode. */
  digest: string;
  /** Each started Work Item's public facts and its own pending criteria. */
  items: Record<
    string,
    WorkItemFacts & { decisions: GitHubProgressDecision[] }
  >;
}

/**
 * Edit the one live status comment per started Work Item issue, and the
 * Objective's, in place (#1325), from planning on. It is the issue's single
 * status comment; new comments are only notifications. Presentation only: a
 * failure never stops the run, and only the comment's creation is recorded,
 * exactly once.
 */
export async function projectLiveStatus(
  args: Args,
  retained: ContinuationState,
  live: () => ContinuationState,
  phase: string,
  step: PlanningStepView | null | undefined,
  presentation: LivePresentation,
): Promise<void> {
  if (!githubProgressSettings(args.config) || !args.github.liveStatusComment)
    return;
  const now = Date.now();
  // Rendered time never enters a transition digest, so it forces no edit.
  const stamp = `<sub>Updated ${displayDateTime(now)}</sub>`;
  const targets: LiveTarget[] = [];
  const itemDigests: string[] = [];
  // Planning has no Work Item yet: the Objective's comment shows its step.
  const planning = isExecutionState(retained)
    ? undefined
    : planningActivity(retained.coordinator.phase, step);
  if (isExecutionState(retained))
    for (const [id, issue] of Object.entries(retained.issueByItemId)) {
      const facts = presentation.items[id];
      if (!facts || !PROGRESS_ITEM_ID.test(id)) continue;
      const tracking = retained.workItemTracking?.[id];
      // A graph revision that rebinds the item to another issue ends its tracking.
      if (tracking && tracking.issue !== issue) continue;
      const active = ACTIVE.includes(facts.status);
      const digest = JSON.stringify(facts);
      itemDigests.push(`${id}:${digest}`);
      targets.push({
        label: `Work Item ${id}`,
        item: { id, issue },
        issue,
        digest,
        active,
        read: (state) =>
          isExecutionState(state)
            ? state.workItemTracking?.[id]?.live
            : undefined,
        write: (state, record) => {
          if (!isExecutionState(state))
            throw new Error(
              "Work Item tracking requires an executing Objective",
            );
          state.workItemTracking ??= {};
          state.workItemTracking[id] ??= { issue };
          state.workItemTracking[id].live = record;
        },
        render: (items, at) => {
          const item = items.find((entry) => entry.id === id);
          return {
            lines: [
              ...workItemStatusLines({
                repository: args.config.repository,
                objective: args.objective,
                item: { id, issue },
                ...facts,
              }),
              ...(item ? workerLines(item, at) : []),
            ],
            details: facts.decisions.length
              ? runDetailsLines({
                  runId: retained.runId,
                  configDigest: retained.configDigest,
                  decisions: facts.decisions,
                })
              : [],
          };
        },
      });
    }
  const objectiveActive = !TERMINAL_PHASES.includes(phase);
  if (objectiveActive || retained.githubLiveStatus)
    targets.push({
      label: `Objective #${args.objective}`,
      issue: args.objective,
      digest: JSON.stringify([
        phase,
        planning,
        presentation.digest,
        ...itemDigests,
      ]),
      active: objectiveActive,
      read: (state) => state.githubLiveStatus,
      write: (state, record) => {
        state.githubLiveStatus = record;
      },
      render: (items, at) => ({
        lines: [
          ...objectiveStatusLines(presentation.status, {
            items: true,
            activeNote: (id) => workerAge(items, id, at),
          }),
          ...(planning === undefined
            ? []
            : planningLines(
                planning,
                retained.coordinator?.phaseStartedAt,
                objectiveModelActivity(args.config.repository, args.objective),
                at,
              )),
        ],
        details: runDetailsLines(presentation.details),
      }),
    });
  const key = (target: LiveTarget) =>
    `${args.config.repository}#${args.objective}:${retained.runId}:${target.issue}`;
  const due = targets.filter((target) => {
    const failed = failedEdit.get(key(target));
    if (
      failed?.digest === target.digest &&
      now - failed.at < backoffMs(failed.failures)
    )
      return false;
    const last = lastEdit.get(key(target));
    if (!last || last.digest !== target.digest) return true;
    return target.active && now - last.at >= REFRESH_MS;
  });
  if (!due.length) return;
  const items = itemActivities(args.config.repository, retained);
  for (const target of due) {
    const marker = liveStatusMarker({
      objective: args.objective,
      runId: retained.runId,
      item: target.item?.id,
    });
    // A settled target's final edit may be the controller's last pass, so a
    // transient failure is tried again here; an active one waits for a later tick.
    for (let attempt = 1; ; attempt += 1) {
      try {
        const { lines, details } = target.render(items, now);
        const body = redactDiagnosticDetail(
          [
            marker,
            ...lines,
            "",
            stamp,
            ...(details.length ? ["", ...details] : []),
          ].join("\n"),
          args.secrets,
        );
        await editLiveStatus(args, retained, live, target, body);
        lastEdit.set(key(target), { digest: target.digest, at: now });
        failedEdit.delete(key(target));
        break;
      } catch (error) {
        if (isCheckpointAdmissionFailure(error)) throw error;
        if (
          !target.active &&
          attempt < FINAL_TRIES &&
          attachedFault(error)?.kind === "transient"
        ) {
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
          continue;
        }
        const failed = failedEdit.get(key(target));
        const failures =
          failed?.digest === target.digest ? failed.failures + 1 : 1;
        failedEdit.set(key(target), {
          digest: target.digest,
          at: Date.now(),
          failures,
        });
        // Presentation only: tried again on the next transition or after the backoff.
        if (failures === 1)
          process.stderr.write(
            `Factory live status for ${target.label} is unavailable: ${redactDiagnosticDetail(error instanceof Error ? error.message : String(error), args.secrets)}\n`,
          );
        break;
      }
    }
  }
}

/** Create the target's comment exactly once, or edit it in place. */
async function editLiveStatus(
  args: Args,
  retained: ContinuationState,
  live: () => ContinuationState,
  target: LiveTarget,
  body: string,
): Promise<void> {
  const record = target.read(live());
  const observed = await args.github.liveStatusComment!({
    objective: args.objective,
    ...(target.item && { item: target.item }),
    runId: retained.runId,
    body,
    ...(record && { record }),
    beforeWrite: async (actorId) => {
      const state = live();
      if (target.read(state))
        throw new Error("A live status create is already recorded");
      target.write(state, { actorId });
      try {
        args.save();
        await awaitCheckpointAdmission(args.config.repository, "before-effect");
      } catch (error) {
        // The POST follows this call, so nothing was sent. A refused save
        // must not leave the record in the live state either.
        const latest = live();
        if (!target.item) delete latest.githubLiveStatus;
        else if (isExecutionState(latest))
          delete latest.workItemTracking?.[target.item.id]?.live;
        args.save();
        throw error;
      }
    },
  });
  const state = live();
  if (JSON.stringify(target.read(state)) !== JSON.stringify(observed)) {
    target.write(state, observed);
    args.save();
  }
}

/** A code span that cannot be broken out of: no backtick, line break or control character. */
const code = (text: string) =>
  `\`${text.replaceAll("`", "'").replace(/[\p{Cc}\u2028\u2029]/gu, "")}\``;

/** A running worker's liveness, changed paths and recent tool calls. */
function workerLines(item: ItemActivity, now: number): string[] {
  const lines: string[] = [];
  const activity = activityLine(item.activity, now, STALE_MS);
  if (activity) lines.push(`- Worker: ${activity}`);
  const changes = changesLine(item.changes?.map(code));
  if (changes) lines.push(`- Files changed ${changes}`);
  const recent = item.activity?.recent
    .map((event) =>
      event.target ? `${event.tool} ${code(event.target)}` : event.tool,
    )
    .join(" · ");
  if (recent) lines.push(`- Recent: ${recent}`);
  return lines.length ? ["", ...lines] : [];
}

/** How long ago an active item's worker last reported, for the Objective's list. */
function workerAge(items: ItemActivity[], id: string, now: number): string {
  const activity = items.find((item) => item.id === id)?.activity;
  if (!activity?.lastEventAt) return "";
  const last = now - Date.parse(activity.lastEventAt);
  const quiet = progressQuietMs(activity, now);
  return ` · worker ${shortAge(last)} ago${last > STALE_MS ? " (stale)" : quiet !== undefined && quiet > PROGRESS_QUIET_MS ? ` · no progress for ${shortAge(quiet)}` : ""}`;
}

/** Planning's step, how long its phase has run and the planner's activity: structured facts only. */
function planningLines(
  activity: string,
  phaseStartedAt: string | undefined,
  model: ModelActivity | undefined,
  now: number,
): string[] {
  const lines = [
    "",
    `**${activity.charAt(0).toUpperCase()}${activity.slice(1)}**`,
  ];
  const since = phaseStartedAt ? Date.parse(phaseStartedAt) : Number.NaN;
  if (Number.isFinite(since))
    lines.push(`- In this phase ${shortAge(now - since)}`);
  if (model) {
    const call = `${model.phase} call`;
    const usage = [
      ...(model.inputTokens !== undefined
        ? [`${formatTokens(model.inputTokens)} input`]
        : []),
      ...(model.outputTokens !== undefined
        ? [`${formatTokens(model.outputTokens)} output tokens`]
        : []),
    ];
    if (model.endedAt !== undefined)
      lines.push(
        `- Model: last ${call} ${model.outcome} after ${shortAge(model.endedAt - model.startedAt)}${usage.length ? ` · ${usage.join(" · ")}` : ""}`,
      );
    else {
      const quiet = now - model.lastEventAt;
      lines.push(
        `- Model: ${call} running ${shortAge(now - model.startedAt)} · last event ${shortAge(quiet)} ago${quiet > STALE_MS ? " (stale)" : ""} · ${model.events} event${model.events === 1 ? "" : "s"}`,
      );
    }
  }
  return lines;
}
