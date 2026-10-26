/**
 * `factory queue`: its options, help and check, and what it does.
 */
import { factoryGitHub } from "../github-app.js";
import { finalShown, requeued } from "../github-sync.js";
import { configOf, Refusal } from "../host.js";
import type { Paths } from "../paths.js";
import { readCards } from "../queue.js";
import { QUEUE_MODES } from "../requests.js";
import { findState, loadQueueControl, TERMINAL } from "../state.js";
import { type Args, type Command, request } from "./shared.js";

export const spec: Command = {
  args: "list|pause|resume|drain",
  flags: { json: "switch" },
  help: "List the Project's queued, candidate and inert cards, or pause, drain or resume the whole queue",
  check: (args) => {
    const action = args.positional[1];
    if (action === "list") return undefined;
    if (!action || !QUEUE_MODES[action])
      return `Unknown queue action ${action ?? "(none)"}; use factory queue list, pause, resume or drain`;
    return args.flags.json === undefined
      ? undefined
      : `--json belongs to factory queue list; use factory queue ${action}`;
  },
  run: ({ paths, repository, args }) => queueCommand(paths, repository, args),
};

/** `factory queue list|pause|resume|drain`. */
async function queueCommand(
  paths: Paths,
  repository: string,
  args: Args,
): Promise<number> {
  const action = args.positional[1]!;
  if (action !== "list")
    return await request(paths, {
      kind: "queue",
      issue: 0,
      mode: QUEUE_MODES[action]!,
    });
  const config = configOf(repository);
  if (!config)
    throw new Refusal(
      "no_configuration",
      `Factory has no configuration for ${repository}, so it can't read the Project.`,
    );
  const github = factoryGitHub(config);
  const { items, truncated, skipped } = await readCards(github, config);
  const control = loadQueueControl(paths.root);
  const { options } = config.queue;
  const queuedOption = options.queued;
  const running = [options.planning, options.building, options.holding];
  const queued: { issue: number; order: number | null; status: string }[] = [];
  const candidates: {
    issue: number;
    option: string | null;
    status?: string;
  }[] = [];
  const inert: { issue: number; option: string | null; reason: string }[] = [];
  for (const card of items) {
    let loaded: ReturnType<typeof findState>;
    try {
      loaded = findState(paths.objectives, card.issue);
    } catch {
      loaded = null;
    }
    const state = loaded?.kind === "ok" ? loaded.state : undefined;
    const finished = state && TERMINAL.includes(state.status);
    if (loaded?.kind === "unreadable")
      inert.push({
        issue: card.issue,
        option: card.option,
        reason: `Its state can't be read (${loaded.error}): factory reset ${card.issue}, or cancel.`,
      });
    else if (!state && card.option && running.includes(card.option))
      // Only a run writes these, so its state is on another machine or lost.
      inert.push({
        issue: card.issue,
        option: card.option,
        reason: `It shows ${card.option}, but this installation has no state for it: factory reset ${card.issue} rebuilds it from GitHub.`,
      });
    else if (card.option !== queuedOption) {
      if (!state || finished)
        candidates.push({
          issue: card.issue,
          option: card.option,
          ...(state ? { status: state.status } : {}),
        });
    } else if (finished && !requeued(card, state, config))
      inert.push({
        issue: card.issue,
        option: card.option,
        reason: finalShown(state, config)
          ? `It has ${state.status}, and the card still reads the queue it ran from. Move it off queued and back to run it again.`
          : `It has ${state.status}, and its final status isn't on the card yet; it runs again once the service shows it.`,
      });
    else if (control.mode !== "running" && (!state || finished))
      inert.push({
        issue: card.issue,
        option: card.option,
        reason: `The queue is ${control.mode}: it is admitted after factory queue resume.`,
      });
    else
      queued.push({
        issue: card.issue,
        order: card.order,
        status: state && !finished ? state.status : "waiting to be admitted",
      });
  }
  queued.sort(
    (a, b) =>
      (a.order ?? Number.MAX_SAFE_INTEGER) -
        (b.order ?? Number.MAX_SAFE_INTEGER) || a.issue - b.issue,
  );
  const result = {
    queue: control,
    queued,
    candidates,
    inert,
    truncated,
    skipped,
  };
  if (args.flags.json !== undefined) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  const lines = [`Queue: ${control.mode}`];
  lines.push(
    queued.length ? "Queued:" : "Queued: none",
    ...queued.map(
      (q) =>
        `  #${q.issue} ${q.status}${q.order !== null ? ` (order ${q.order})` : ""}`,
    ),
    candidates.length
      ? "Candidates (set Status to queued to run):"
      : "Candidates: none",
    ...candidates.map(
      (c) =>
        `  #${c.issue} ${c.option ?? "(no status)"}${c.status ? `, ${c.status}` : ""}`,
    ),
  );
  if (inert.length)
    lines.push(
      "Inert cards:",
      ...inert.map((i) => `  #${i.issue}: ${i.reason}`),
    );
  if (truncated) lines.push(`${truncated} more cards weren't read.`);
  if (skipped.length)
    lines.push(
      "Cards GitHub answered with an error for (left out):",
      ...skipped.map(
        (s) => `  ${s.issue ? `#${s.issue}` : "a card"}: ${s.error}`,
      ),
    );
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
