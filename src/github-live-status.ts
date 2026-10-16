import { type FactoryConfig, githubProgressSettings } from "./config.js";
import type { GitHubGateway } from "./contracts.js";
import { redactDiagnosticDetail } from "./diagnostics.js";
import { attachedFault } from "./fault.js";
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
import {
  activityLine,
  changesLine,
  type ItemActivity,
  itemActivities,
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
  /** Status, step, attempt and pull request; a change edits at once. */
  digest: string;
  active: boolean;
  read: (state: ContinuationState) => LiveStatusRecord | undefined;
  write: (state: ContinuationState, record: LiveStatusRecord) => void;
  render: (items: ItemActivity[], now: number) => string;
}

/**
 * Edit the one live status comment per active Work Item issue, and the
 * Objective's, in place (#1325). Presentation only: a failure never stops the
 * run, and only the comment's creation is recorded, exactly once.
 */
export async function projectLiveStatus(
  args: Args,
  retained: ContinuationState,
  live: () => ContinuationState,
  phase: string,
): Promise<void> {
  if (!githubProgressSettings(args.config) || !args.github.liveStatusComment)
    return;
  if (!isExecutionState(retained)) return;
  const now = Date.now();
  const stamp = `<sub>Updated ${new Date(now).toISOString().slice(0, 16).replace("T", " ")}Z · edited in place while work runs</sub>`;
  const targets: LiveTarget[] = [];
  const itemDigests: string[] = [];
  for (const [id, issue] of Object.entries(retained.issueByItemId)) {
    const work = retained.work[id];
    if (!work || !PROGRESS_ITEM_ID.test(id)) continue;
    if (work.status === "pending" || work.status === "skipped") continue;
    const tracking = retained.workItemTracking?.[id];
    // A graph revision that rebinds the item to another issue ends its tracking.
    if (tracking && tracking.issue !== issue) continue;
    const active = ACTIVE.includes(work.status);
    // A settled item gets no new comment; an existing one gets its final edit.
    if (!active && !tracking?.live) continue;
    const digest = JSON.stringify([
      work.status,
      work.step,
      work.attempt,
      work.pullRequest,
    ]);
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
          throw new Error("Work Item tracking requires an executing Objective");
        state.workItemTracking ??= {};
        state.workItemTracking[id] ??= { issue };
        state.workItemTracking[id].live = record;
      },
      render: (items, at) => {
        const item = items.find((entry) => entry.id === id);
        return itemBody(item ?? { id, status: work.status }, at);
      },
    });
  }
  const objectiveActive = !TERMINAL_PHASES.includes(phase);
  if (objectiveActive || retained.githubLiveStatus)
    targets.push({
      label: `Objective #${args.objective}`,
      issue: args.objective,
      digest: JSON.stringify([phase, ...itemDigests]),
      active: objectiveActive,
      read: (state) =>
        isExecutionState(state) ? state.githubLiveStatus : undefined,
      write: (state, record) => {
        if (!isExecutionState(state))
          throw new Error("Live status requires an executing Objective");
        state.githubLiveStatus = record;
      },
      render: (items, at) => objectiveBody(phase, items, at),
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
    const body = redactDiagnosticDetail(
      `${marker}\n${target.render(items, now)}\n\n${stamp}`,
      args.secrets,
    );
    // A settled target's final edit may be the controller's last pass, so a
    // transient failure is tried again here; an active one waits for a later tick.
    for (let attempt = 1; ; attempt += 1) {
      try {
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
      args.save();
      try {
        await awaitCheckpointAdmission(args.config.repository, "before-effect");
      } catch (error) {
        // The POST follows this call, so nothing was sent.
        const latest = live();
        if (isExecutionState(latest)) {
          if (target.item)
            delete latest.workItemTracking?.[target.item.id]?.live;
          else delete latest.githubLiveStatus;
        }
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

function itemBody(item: ItemActivity, now: number): string {
  const lines = [`### Live status · ${item.id}`, "", `**${headline(item)}**`];
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
  return lines.join("\n");
}

function objectiveBody(
  phase: string,
  items: ItemActivity[],
  now: number,
): string {
  const lines = [`### Live status · ${phase}`, ""];
  for (const item of items) {
    if (item.status === "pending" || item.status === "skipped") continue;
    const last = item.activity?.lastEventAt
      ? now - Date.parse(item.activity.lastEventAt)
      : undefined;
    lines.push(
      `- ${headline(item)}${last === undefined ? "" : ` · worker ${shortAge(last)} ago${last > STALE_MS ? " (stale)" : ""}`}`,
    );
  }
  if (lines.length === 2) lines.push("No Work Item has started yet.");
  return lines.join("\n");
}

function headline(item: ItemActivity): string {
  return [
    `${item.id} · ${item.status}${item.step ? ` (${item.step})` : ""}`,
    ...(item.pullRequest ? [`PR #${item.pullRequest}`] : []),
  ].join(" · ");
}
