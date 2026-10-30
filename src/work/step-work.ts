import { lstat, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ACCEPT } from "../delivery.js";
import { hold, type Outcome, type StepContext } from "../engine.js";
import { defaultHead } from "../git.js";
import {
  captureAssets,
  destinationFinding,
  type MediaOutcome,
  mediaDirectory,
  missingMember,
  needsSelection,
  resentSet,
  resolveInputs,
  restoreDestinations,
  sentBackDirectory,
  sentBackInputs,
} from "../media.js";
import { mayChange, objectiveText } from "../objective.js";
import { forceRemove } from "../paths.js";
import { BaseFiles, finalCommands, fixedScripts } from "../planning/facts.js";
import { ACCEPTED_AT, acceptedInputs, currentPlan } from "../planning/plan.js";
import { packageManagerUpdate } from "../planning/prompts.js";
import { repositoryView } from "../planning/repository.js";
import { peerNotes } from "../planning/schedule.js";
import type { Plan, WorkItem } from "../planning/types.js";
import {
  conversationDir,
  type Session,
  scopeOf,
} from "../providers/session.js";
import type { ReviewConversation } from "../review/result.js";
import type { ObjectiveState } from "../state.js";
import {
  addWorktree,
  changedFiles,
  hostGit,
  hostGitExit,
  worktreePath,
} from "../worktree.js";
import { blameAmendment, discoveryOutcome } from "./amend.js";
import { collect, type HandoffNote } from "./collect.js";
import { fact, facts, written } from "./facts.js";
import { prepareWorkPrompt } from "./prompt.js";
import { refusedOf, refusedResult, refusedTreeFor } from "./refused.js";
import { repairContext } from "./repair-context.js";
import type { WorkerValidateFailure } from "./self-validate.js";
import { itemMemory } from "./shared.js";
import { correctsMedia, repairOutcome } from "./step-deliver.js";
import { refusalDecisions } from "./step-review.js";
import {
  type BuildDeps,
  candidate,
  layerBelow,
  type Phase,
  REVALIDATE,
  type StackPlace,
  selection,
  stepKey,
  type WorkResult,
} from "./steps.js";
import { ActivityLog } from "./worker.js";

// ---------------------------------------------------------------------------
// work

export async function workStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
  place: StackPlace | undefined,
): Promise<Outcome> {
  const { state, signal } = context;
  const { config } = deps;
  const plan = currentPlan(state)!;
  const { shown } = acceptedInputs(state);
  const body = shown.body;
  const workDir = deps.workDir(state.issue);
  const worktree = worktreePath(workDir, state.issue, item.id);
  const media = mediaDirectory(workDir, item.id);
  const sentBack = fact(state, "sentBack", item.id);
  // Read before the worker runs: once it has finished, a failed read would
  // lose its result, which is kept only with this step's outcome.
  const author = await deps.github.commitAuthor(signal);
  // Its fact is gone (new sets captured, or `fresh`): so are the copies.
  if (!sentBack) await forceRemove(sentBackDirectory(media));
  // An item builds on the default branch as it is when it starts, which
  // holds every merged dependency; a native-stack layer above the bottom
  // builds on the layer below's current delivered head: the head a merge
  // check named (`onto`), else its CI's (GitHub may have updated the
  // branch), else its published one. It keeps that base across repairs.
  const below = layerBelow(place);
  const start = async () => {
    if (!below) return defaultHead(config.checkout, config.repository, signal);
    const delivered = (phase: Phase) =>
      (state.done[stepKey(below.id, phase)] as { head: string } | undefined)
        ?.head;
    return (
      fact(state, "onto", item.id) ?? delivered("ci") ?? delivered("publish")!
    );
  };
  const keptBase = fact(state, "base", item.id);
  let base = keptBase ?? (await start());
  const added = await addWorktree(
    config.checkout,
    worktree,
    base,
    signal,
    context.log,
  );
  let replayed = false;
  if (added === "kept" && keptBase === undefined) {
    // A worktree from an attempt that never kept its base (interrupted
    // before its outcome) sits on that attempt's base, which the default
    // branch may have left since: start over on this one.
    await rebaseWorktree(
      config.checkout,
      worktree,
      base,
      base,
      undefined,
      signal,
    );
  } else if (fact(state, "rebase", item.id)) {
    // A conflict or failed delivery: move onto the current start and replay
    // the kept change, so the worker can resolve it there.
    const head = await start();
    const replay = fact(state, "refused", item.id)?.commit;
    if (head !== base) {
      replayed = await rebaseWorktree(
        config.checkout,
        worktree,
        base,
        head,
        replay,
        signal,
      );
      base = head;
    }
  }
  const keepBase = facts({ base, rebase: false, onto: null }, item.id);
  let finished = fact(state, "finished", item.id);
  let own = fact(state, "selection", item.id);
  let candidates = fact(state, "candidates", item.id);
  // A conflict repair whose replay applied cleanly onto the change's own
  // base is mechanical: the replayed change is the result, collected,
  // validated and reviewed again with no worker run. A media item's
  // worker runs, for its candidates.
  if (
    !finished &&
    replayed &&
    !needsSelection(item) &&
    fact(state, "finding", item.id)?.kind === "conflict"
  )
    finished = {
      finalResponse: `Factory replayed the previous result onto ${base} with no conflict.`,
      replayed: true,
    };
  let keepAll: Record<string, unknown> = keepBase;
  // The worker finished and collection asked: `repair` sends the result
  // back; any other answer collects it again.
  if (finished && context.answer?.answer === "repair") {
    const finding = `The operator sent this result back for repair${context.answer.text ? `: ${context.answer.text}` : "."}`;
    return repairOutcome(item, "work", finding, context.state, place, {
      keep: keepBase,
    });
  }
  if (!finished && context.answer?.answer === REVALIDATE) {
    // The operator says the refused result is correct and Factory's check
    // was at fault: it is the step's result again, unchanged, with no
    // worker run, collection or repair. Only reads: a rerun does the same.
    // The engine charged it to resultRereviews when the answer landed.
    const refused = await refusedResult(
      state,
      item,
      config.checkout,
      base,
      signal,
    );
    // The hold is marked unrecheckable (`recheckMark`).
    if (!refused)
      return withKeep(
        hold(
          `Work Item ${item.id}'s refused result can no longer be checked again as it is (it is gone, or no longer sits on ${base}). Answer \`retry\` to diagnose the failure again, or cancel.`,
          ["retry", "cancel"],
        ),
        keepBase,
      );
    // Delivery judges its failed checks as on the operator's `retry`
    // (step-deliver.ts `pullInput`): the default branch may have been
    // what failed them, and a failure nothing has run again since is a
    // question, not the same repair again.
    return {
      kind: "done",
      result: refused,
      keep: {
        ...keepBase,
        ...facts(
          {
            finished: null,
            finding: null,
            refused: null,
            rereviewed: {
              commit: refused.commit,
              at: context.answer.at,
            },
            // The operator's own `revalidate` runs the commands again;
            // Factory's, after the worker resubmitted the refused result
            // unchanged (engine.ts `rereview`), reuses the validation of
            // that same commit when nothing it ran under changed
            // (step-validate.ts `reusedValidation`, #2174).
            ...(context.answer.channel === "factory"
              ? {}
              : { validation: null }),
          },
          item.id,
        ),
      },
    };
  }
  // `accept <n>` to a question about a review refusal: recorded as the
  // operator's decision on the refused tree, then the refused result is
  // checked again when nothing it was refused on still stands, else what
  // still stands is diagnosed, within the repair allowances.
  let finding = fact(state, "finding", item.id);
  /** A decision narrowed the finding: its saved diagnosis no longer applies. */
  let narrowed = false;
  if (
    !finished &&
    context.answer?.answer === ACCEPT &&
    finding?.kind === "review" &&
    // Recorded already: a run past a spent allowance saved what it left
    // standing and its diagnosis, which the repair after `more` uses.
    !(fact(state, "decisions", item.id) ?? []).some(
      (entry) => entry.holdId === context.answer?.holdId,
    )
  ) {
    const decided = refusalDecisions(context, finding, item.id);
    keepAll = { ...keepAll, ...decided.keep };
    if (!decided.standing.length) {
      const refused = await refusedResult(
        state,
        item,
        config.checkout,
        base,
        signal,
      );
      // The hold is marked unrecheckable (`recheckMark`).
      if (!refused)
        return withKeep(
          hold(
            `What Work Item ${item.id}'s result was refused on is accepted, but the refused result can no longer be checked again (it is gone, or no longer sits on ${base}). Answer \`fresh\` to start it again on the current base, or cancel.`,
            ["fresh", "cancel"],
          ),
          keepAll,
        );
      return {
        kind: "done",
        result: refused,
        keep: {
          ...keepAll,
          ...facts({ finished: null, finding: null, refused: null }, item.id),
        },
      };
    }
    finding = { ...finding, refused: decided.standing };
    // The saved diagnosis was of the whole finding: what still stands is
    // diagnosed again (repairContext), keeping the corrections tried.
    const saved = fact(state, "diagnosis", item.id);
    keepAll = {
      ...keepAll,
      ...facts(
        { finding, ...(saved ? { diagnosis: { ...saved, repair: 0 } } : {}) },
        item.id,
      ),
    };
    narrowed = true;
    // Past a spent allowance, repairContext diagnoses what still stands,
    // saves it, and the engine asks for `more` (`diagnoseFirst`).
  }
  if (!finished) {
    // Whether the checkout holds any change, read before Factory writes the
    // worker's inputs into it: an empty change from a checkout that held
    // the refused result is that result removed, never kept (#2131).
    const bare =
      refusedOf(state, item.id) !== undefined &&
      (await holdsNoChange(worktree, base, signal));
    // A merged predecessor's blame answered `amend`, or its amendment
    // settled: no diagnosis runs again.
    const amended = blameAmendment(item, context, place, keepBase);
    if (amended) return amended;
    const repair = await repairContext(
      item,
      context,
      deps,
      base,
      finding,
      plan,
      narrowed,
    );
    // A question keeps this attempt's base and any decision just
    // recorded; a predecessor's repair moves this item onto the
    // predecessor's new head, so its facts win.
    // Its own facts win: a fresh diagnosis replaces one a decision voided.
    if (repair && "outcome" in repair)
      return repair.outcome.kind === "replace"
        ? repair.outcome
        : { ...repair.outcome, keep: { ...keepAll, ...repair.outcome.keep } };
    keepAll = { ...keepAll, ...(repair?.keep ?? {}) };
    // The correction is about the kept selection (or the kept candidates),
    // which no repair can change: those sets no longer stand, so this
    // attempt makes new candidates with the correction, from read-only
    // copies of them, and the operator chooses again. The facts go with the
    // worker's result or a repair; a hold or retry before it keeps them, so
    // its rerun decides the same from the saved diagnosis.
    const kept = own ? [own.selection.set] : (candidates ?? []);
    const path = repair?.path;
    const remade =
      path !== undefined && correctsMedia(item, path, kept)
        ? {
            sets: kept.map((set) => (own ? set.id.toLowerCase() : set.id)),
            path,
            chosen: own !== undefined,
          }
        : undefined;
    const replaced = remade
      ? await sentBackInputs(item.id, kept, "replaced")
      : [];
    const dropped = remade
      ? facts({ selection: null, candidates: null }, item.id)
      : {};
    if (remade) {
      own = undefined;
      candidates = undefined;
    }
    // A kept selection whose private copies are gone can't be written
    // again: this attempt makes new candidates and the operator chooses.
    if (own && (await missingMember(own.selection.set))) {
      own = undefined;
      keepAll = { ...keepAll, ...facts({ selection: null }, item.id) };
    }
    // Likewise kept candidates: with a copy gone, this attempt stages anew.
    if (candidates && !own) {
      const lost = await Promise.all(candidates.map(missingMember));
      if (lost.some(Boolean)) {
        candidates = undefined;
        keepAll = { ...keepAll, ...facts({ candidates: null }, item.id) };
      }
    }
    const inputs = await resolveInputs({
      checkout: config.checkout,
      repository: config.repository,
      directory: media,
      plan,
      item,
      base,
      body: objectiveText(shown.blocks),
      localAssetRoots: config.media.localAssetRoots,
      selection: selection(state),
      ...(own ? { kept: own.selection } : {}),
      githubToken: () => deps.github.serviceToken(),
      signal,
    });
    if (inputs.kind !== "done")
      return mediaOutcome(
        item,
        inputs,
        context,
        place,
        inputs.kind === "repair" ? { ...keepAll, ...dropped } : keepAll,
      );
    // Review gets the same inputs (InputRecord): the last ones resolved.
    keepAll = { ...keepAll, ...facts({ inputs: inputs.value }, item.id) };

    const files = new BaseFiles(config.checkout, base, signal);
    // Every existing script a plan or required command runs stays fixed.
    const scripts = await fixedScripts(
      [
        ...finalCommands(config.finalValidation.requiredCommands),
        ...plan.items.flatMap((planned) =>
          planned.validation.map((v) => v.command),
        ),
      ],
      files,
    );
    const pin = packageManagerUpdate(shown.blocks);
    const memory = await itemMemory("work", item, context, deps, base);
    const profile = item.executionProfile?.id;
    const instructions =
      profile === undefined
        ? undefined
        : config.execution.profiles?.[profile]?.instructions;
    const prepared = await prepareWorkPrompt({
      checkout: config.checkout,
      worktree,
      objective: state.issue,
      objectiveBody: body,
      plan,
      item,
      base,
      conventions: (await repositoryView(config.checkout, base, false, signal))
        .conventions,
      fixedScripts: scripts.map((script) => script.name),
      ...(pin ? { packageManagerUpdate: pin } : {}),
      ciOnlyCommands: config.finalValidation.ciOnlyCommands,
      ...(config.validation.formatCommand
        ? { formatCommand: config.validation.formatCommand }
        : {}),
      ...(repair ? { repair: repair.context } : {}),
      mediaInputs: [
        ...inputs.value,
        ...(await sentBackInputs(item.id, sentBack ?? [])),
        ...replaced,
      ],
      ...(own
        ? {
            keptSelection: {
              set: own.selection.set.id.toLowerCase(),
              destinations: own.selection.set.members.map((m) => m.destination),
            },
          }
        : candidates
          ? {
              keptCandidates: {
                sets: candidates.map((set) => set.id),
                destinations: [
                  ...new Set(
                    candidates.flatMap((set) =>
                      set.members.map((m) => m.destination),
                    ),
                  ),
                ],
              },
            }
          : {}),
      ...(remade ? { remade } : {}),
      peerNotes: peerNotes(plan, acceptedNotes(state, plan), item),
      ...(memory ? { memory } : {}),
      ...(instructions ? { profileInstructions: instructions } : {}),
      signal,
    });
    if ("problem" in prepared)
      return withKeep(
        hold(prepared.problem, ["retry", "replan", "cancel"]),
        keepAll,
      );

    const spent = fact(state, "spend", item.id);
    // A repair continues the item's worker conversation when it can.
    const conversation = retained(
      state,
      deps,
      `work-${item.id}`,
      item,
      fact(state, "workSession", item.id),
    );
    const worker = deps.worker(plan, shown.blocks, profile);
    // Made last before the run, which always closes it.
    const activity = new ActivityLog(
      item.id,
      worktree,
      context.log,
      deps.config.secrets,
      {
        transcript: context.runFile("transcript"),
        changes: () => changedFiles(worktree, signal),
      },
    );
    const { spend, session, ...result } = await worker
      .run({
        worktree,
        prompt: prepared.prompt,
        facts: prepared.facts,
        ...(conversation
          ? { conversation: { ...conversation, prompt: prepared.prompt } }
          : {}),
        item,
        commands: item.validation.map((v) => v.command),
        base,
        signal,
        log: context.log,
        activity: activity.report,
        output: activity.output,
        runFile: context.runFile,
        ...(spent ? { spend: spent } : {}),
        ...(context.answer ? { answer: context.answer } : {}),
      })
      .finally(async () => {
        // What the worktree holds at the end, shell edits included.
        await activity.sample();
        activity.close();
      });
    if (conversation)
      context.keep(facts({ workSession: session ?? null }, item.id));
    // A paid worker's spend outlives retries, restarts and repairs.
    if (spend) keepAll = { ...keepAll, ...facts({ spend }, item.id) };
    if (result.kind !== "finished") return withKeep(result, keepAll);
    finished = {
      finalResponse: result.finalResponse,
      ...(result.validated ? { validated: result.validated } : {}),
      ...(bare ? { bare: true as const } : {}),
    };
    keepAll = {
      ...keepAll,
      ...dropped,
      ...workerFailedKept(state, item.id, result.validateFailed),
    };
  }

  // Capture before collection, which deletes the media manifest, and keep
  // the captured sets before anything destructive: the step runs again at
  // once and collects with them. A repair whose selection stands has no
  // manifest and keeps the sets the selection came from; one that staged
  // new sets anyway forgets the selection first (capture replaces the kept
  // copies), and the operator chooses from the new sets.
  if (!finished.sets && own) {
    const staged = await lstat(join(worktree, ".factory-assets.json")).then(
      () => true,
      () => false,
    );
    if (staged)
      return {
        kind: "retry",
        reason:
          "The repair staged new candidate sets, so the operator chooses again",
        progress: true,
        keep: { ...keepAll, ...facts({ finished, selection: null }, item.id) },
      };
    finished = { ...finished, sets: own.sets };
  }
  // Kept candidates stand in for capture, unless this attempt staged a new
  // manifest: then capture replaces them.
  if (!finished.sets && !own && candidates) {
    const staged = await lstat(join(worktree, ".factory-assets.json")).then(
      () => true,
      () => false,
    );
    if (staged)
      keepAll = { ...keepAll, ...facts({ candidates: null }, item.id) };
    else finished = { ...finished, sets: candidates };
  }
  if (!finished.sets) {
    const captured = await captureAssets({
      secretlintConfig: config.policy.secretlintConfig,
      worktree,
      item,
      directory: media,
      signal,
    });
    if (captured.kind !== "done")
      return mediaOutcome(item, captured, context, place, {
        ...keepAll,
        ...facts({ finished }, item.id),
      });
    const resent = resentSet(captured.value, sentBack ?? []);
    if (resent)
      return mediaOutcome(
        item,
        {
          kind: "repair",
          staging: "candidates",
          finding: `Candidate set ${resent.set} has the content of set ${resent.sentBack}, which the operator sent back. Stage new content for every set.`,
        },
        context,
        place,
        { ...keepAll, ...facts({ finished }, item.id) },
      );
    if (captured.value.length)
      return {
        kind: "retry",
        reason: "Candidate media sets captured; collecting the result",
        progress: true,
        keep: {
          ...keepAll,
          ...facts(
            {
              finished: { ...finished, sets: captured.value },
              candidates: captured.value,
              sentBack: null,
            },
            item.id,
          ),
        },
      };
    finished = { ...finished, sets: [] };
  }
  const sets = finished.sets ?? [];
  // The kept copies replace the worker's staging, manifest included: a
  // repair after a refused collection must not capture its stale manifest.
  // The destinations are Factory's, so they go back to the base, whatever
  // the worker wrote there or Factory's earlier collection commit holds.
  if (sets.length) {
    await Promise.all(
      [".factory-media", ".factory-assets.json"].map((path) =>
        forceRemove(join(worktree, path)),
      ),
    );
    await restoreDestinations({ worktree, base, sets, signal });
  }
  const keepFinished = { ...keepAll, ...facts({ finished }, item.id) };

  const collected = await collect({
    secretlintConfig: config.policy.secretlintConfig,
    worktree,
    base,
    plan,
    item,
    mayChange: mayChange(shown.blocks).paths,
    playbook: config.planning.playbook,
    sandbox: config.sandbox,
    finalResponse: finished.finalResponse,
    // New candidates are a new result, even on the refused tree.
    refusedTree: refusedTreeFor(state, item.id, {
      sets,
      selectionStands: own !== undefined,
    }),
    // A Work Item that owns only its media destinations changes nothing
    // else: its candidates are its result.
    media: sets.length > 0,
    author,
    signal,
  });
  const discovered = discoveryOutcome(
    item,
    context,
    place,
    collected,
    keepFinished,
  );
  if (discovered) return discovered;
  switch (collected.kind) {
    case "collected": {
      const outside = await destinationFinding({
        worktree,
        base,
        commit: collected.commit,
        sets,
        signal,
      });
      // About the candidates, like a capture refusal: the next attempt
      // stages them again, since their staging is gone.
      if (outside)
        return repairOutcome(
          item,
          "work",
          { kind: "failure", detail: outside, staging: "candidates" },
          context.state,
          place,
          { keep: keepAll },
        );
      const done: WorkResult = {
        base,
        commit: collected.commit,
        tree: collected.tree,
        // A replay's collection has no handoff file: the notes are kept.
        notes: finished.replayed
          ? (fact(state, "refused", item.id)?.notes ?? [])
          : collected.notes,
        ...(finished.validated ? { validated: finished.validated } : {}),
        sets,
      };
      // The result carries the sets now; selection keeps the chosen one.
      return {
        kind: "done",
        result: done,
        keep: {
          ...keepAll,
          ...facts(
            { finished: null, finding: null, refused: null, candidates: null },
            item.id,
          ),
        },
      };
    }
    case "repair":
      // The operator's guidance was this attempt's only correction, and the
      // worker made no change: it resubmitted the refused result as it was,
      // or left a checkout that held no change when it started (one added
      // again at the kept base, which never held the refused result) as it
      // was. Whatever the guidance said, that is no repair: the refused
      // result is checked again as `revalidate` would check it (a result
      // rereview), or the operator is asked. Any other attempt with no
      // change is refused as before, an empty change from a checkout that
      // held the refused result (the worker removed it) included.
      if (
        (collected.unchanged ||
          (collected.empty &&
            finished.bare === true &&
            refusedOf(state, item.id) !== undefined)) &&
        !collected.staging &&
        guidedOnly(state, item.id, keepAll)
      )
        return keptAsGuided(
          item,
          finished.finalResponse,
          collected.unchanged ? "unchanged" : "empty",
          { ...keepAll, ...facts({ finished: null }, item.id) },
        );
      return repairOutcome(
        item,
        "work",
        {
          kind: "failure",
          detail: collected.finding,
          ...(collected.staging ? { staging: collected.staging } : {}),
        },
        context.state,
        place,
        {
          keep: keepAll,
        },
      );
    default:
      return withKeep(collected, keepFinished);
  }
}

/**
 * The item's `workerValidateFailed` fact for a finished worker run: the
 * commands its own Validate failed and passed no more, under the plan
 * accepted now, which an amendment may replace (#2199); none deletes it.
 */
export function workerFailedKept(
  state: ObjectiveState,
  itemId: string,
  failures: readonly WorkerValidateFailure[] | undefined,
): Record<string, unknown> {
  return facts(
    {
      workerValidateFailed: failures?.length
        ? {
            plan: String(state.kept[ACCEPTED_AT] ?? ""),
            failures: [...failures],
          }
        : null,
    },
    itemId,
  );
}

/**
 * Whether this attempt's only correction was the operator's guidance (their
 * `answer` to its repair diagnosis question, repair-context.ts): the
 * diagnosis for the item's current repair, written by this run or saved for
 * it, is the operator's, with no correction of Factory's.
 */
export function guidedOnly(
  state: ObjectiveState,
  id: string,
  keep: Record<string, unknown>,
): boolean {
  const now = written(keep, "diagnosis", id);
  const diagnosis = now === undefined ? fact(state, "diagnosis", id) : now;
  return (
    !!diagnosis &&
    diagnosis.repair === state.repairs?.[stepKey(id, "work")]?.count &&
    diagnosis.context.operator !== undefined &&
    diagnosis.context.correction === undefined
  );
}

/**
 * Whether `worktree` holds no change from `base`: HEAD is the base, and
 * Git reports no changed or untracked file (an ignored one is no change).
 */
async function holdsNoChange(
  worktree: string,
  base: string,
  signal: AbortSignal,
): Promise<boolean> {
  const head = (await hostGit(worktree, ["rev-parse", "HEAD"], { signal }))
    .toString("utf8")
    .trim();
  return head === base && (await changedFiles(worktree, signal)).length === 0;
}

/** The longest worker final response a question quotes. */
const KEPT_RESPONSE_LIMIT = 2000;

/**
 * After the operator's guidance, the attempt's only correction, the worker
 * made no change (#2131): it resubmitted the refused result unchanged
 * (`unchanged`), or left a checkout that held no change as it was (`empty`,
 * with the finished run `bare`). Factory never reads
 * the guidance, so this holds whatever it said; the question quotes the
 * worker's final response for the operator to judge. That is no repair:
 * the engine answers `revalidate` for it where it is taken and a result
 * rereview is left (engine.ts `rereview`), so the refused result is checked
 * again, charged as a rereview; else this question asks, and the engine
 * adds `revalidate` (with its sentence) where the item can take it, so past
 * the rereview allowance it asks for `more`.
 */
function keptAsGuided(
  item: WorkItem,
  finalResponse: string,
  how: "unchanged" | "empty",
  keep: Record<string, unknown>,
): Outcome {
  const text = finalResponse.trim();
  const said =
    text.length > KEPT_RESPONSE_LIMIT
      ? `${text.slice(0, KEPT_RESPONSE_LIMIT)}...`
      : text;
  const did =
    how === "unchanged"
      ? "resubmitted its refused result unchanged"
      : "made no change";
  return {
    ...hold(
      `After your guidance, Work Item ${item.id}'s worker ${did}, so there is no new result, and no repair is charged for it.${said ? `\n\nThe worker's final response: ${said}` : ""}\n\nFactory checks the refused result again as a result rereview when it can; it can't now (the result can't be checked again as it is, or this Objective's result rereviews are spent). Answer \`answer <text>\` to send the worker other guidance, \`replan\` to plan again, or cancel.`,
      ["answer", "replan", "cancel"],
    ),
    rereview: true,
    keep,
  };
}

/** A media answer other than done as the step's outcome: `repair` goes back to the work step. */
export function mediaOutcome(
  item: WorkItem,
  outcome: Exclude<MediaOutcome<unknown>, { kind: "done" }>,
  context: StepContext,
  place: StackPlace | undefined,
  keep: Record<string, unknown> = {},
  from: Phase = "work",
): Outcome {
  switch (outcome.kind) {
    case "repair":
      return repairOutcome(
        item,
        from,
        outcome.staging
          ? {
              kind: "failure",
              detail: outcome.finding,
              staging: outcome.staging,
            }
          : outcome.finding,
        context.state,
        place,
        { keep },
      );
    case "retry":
      return { kind: "retry", reason: outcome.reason, keep };
    default:
      return { ...outcome, keep };
  }
}

/**
 * Handoff notes of every item whose result was accepted (validated and
 * reviewed), by item, each with that result's commit.
 */
export function acceptedNotes(
  state: ObjectiveState,
  plan: Plan,
): Map<string, (HandoffNote & { commit: string })[]> {
  const notes = new Map<string, (HandoffNote & { commit: string })[]>();
  for (const other of plan.items) {
    const work = state.done[stepKey(other.id, "work")] as
      | WorkResult
      | undefined;
    if (
      work &&
      state.done[stepKey(other.id, "validate")] &&
      state.done[stepKey(other.id, "review")]
    )
      notes.set(
        other.id,
        work.notes.map((note) => ({
          ...note,
          commit: candidate(state, other.id),
        })),
      );
  }
  return notes;
}

/**
 * A retained conversation of this Objective (providers/session.ts) that
 * continues `previous`, scoped to the accepted plan, so a replan or a
 * reset starts it fresh; none with `sessions.enabled` off.
 */
export function retained(
  state: ObjectiveState,
  deps: BuildDeps,
  name: string,
  /** What it reviews or builds: its Work Item's design, or the whole plan; an amendment that changes it starts fresh. */
  design: unknown,
  previous: Session | undefined,
): ReviewConversation | undefined {
  if (!deps.config.sessions.enabled) return undefined;
  return {
    dir: conversationDir(deps.workDir(state.issue), name),
    // The accepted plan, the design and the frozen configuration: a
    // replan, a reset, an amendment or `adopt` starts fresh.
    scope: scopeOf(state.kept[ACCEPTED_AT], design, state.frozen?.digest),
    policy: deps.config.sessions,
    ...(previous ? { previous } : {}),
  };
}

/**
 * An answer that asks for an independent second look (`retry`,
 * `revalidate`): the review starts fresh, not from its own earlier
 * verdict.
 */
export function secondLook(context: StepContext): boolean {
  const answer = context.answer?.answer;
  return answer === "retry" || answer === "revalidate";
}

/** Add facts to keep to any outcome that can carry them. */
export function withKeep(
  outcome: Outcome,
  keep: Record<string, unknown>,
): Outcome {
  if (outcome.kind === "replace") return outcome;
  return { ...outcome, keep: { ...(outcome.keep ?? {}), ...keep } };
}

/**
 * Move a kept worktree from `from` to `to` and replay the kept change
 * (`replay`) on it: that commit's own change, from its parent. Conflicts
 * stay in the files for the worker to resolve. True only when the change
 * was built on `from` and applied whole with no conflict: the worktree
 * then holds `to` plus exactly that change. A change on another base (an
 * attempt stopped after its base moved) is replayed for the worker, never
 * taken as it is.
 */
export async function rebaseWorktree(
  checkout: string,
  worktree: string,
  from: string,
  to: string,
  replay: string | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  await hostGit(worktree, ["checkout", "--detach", "--force", to], { signal });
  await hostGit(worktree, ["clean", "-ffdx", "--", "."], { signal });
  if (!replay) return false;
  const parent = (
    await hostGit(checkout, ["rev-parse", `${replay}^`], { signal })
  )
    .toString("utf8")
    .trim();
  const diff = await hostGit(
    checkout,
    ["diff", "--binary", "--no-ext-diff", "--no-textconv", parent, replay],
    { signal },
  );
  if (!diff.length) return false;
  // Applying may conflict; the worker resolves what remains. The patch is
  // passed as a file: its bytes need not be UTF-8.
  const patch = `${worktree}.replay.patch`;
  await writeFile(patch, diff, { mode: 0o600 });
  try {
    const applied = await hostGitExit(
      worktree,
      ["apply", "--3way", "--whitespace=nowarn", patch],
      { signal },
    );
    return applied.code === 0 && parent === from;
  } finally {
    await rm(patch, { force: true });
  }
}
