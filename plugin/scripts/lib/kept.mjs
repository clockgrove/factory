// The rebase check's judgement (outbox.mjs rebaseLeft): when a send-back's conflict pass reshaped one of the branch's
// commits so that no exact check can tell whether its change survived, a decision model is asked whether it is kept.
// The decision model sits behind the decider adapter (adapters/decider.mjs, docs/ADAPTERS.md), with the key and the
// model setting of red-check triage (triage.mjs). Only the typed label reaches code: `kept` alone keeps the commit, and
// a "lost" answer, no answer or a failed call names it as dropped. This runs in Factory's own process, never in a harness.
import { openDecider } from "./adapters/decider.mjs";
import { log, mask, redactSecrets } from "./inputs.mjs";
import { TRIAGE_MODEL, triageKey } from "./triage.mjs";

/** The one question asked about each reshaped commit. */
export const KEPT_QUESTION = {
  type: "choice",
  name: "change_kept",
  instructions:
    "An unattended coding agent rebased its branch onto the default branch and resolved the conflicts. " +
    "Given one commit of the branch before the rebase, the branch's whole change and the default branch's change since they split (both on the same files), " +
    "and the rebased branch's change against the default branch's head on those files, decide whether everything the commit changed is still in the rebased branch.",
  choices: [
    { value: "kept", description: "Every part of the commit's change is in the rebased branch, as written or adapted to fit the default branch's change; a part that a later commit of the same branch replaced counts as kept when that later version is in the rebased branch." },
    { value: "lost", description: "Some part of the commit's change is missing from the rebased branch: dropped in resolving the conflict, undone, or replaced by the default branch's version." },
  ],
};

const NONE = "(no change)";

/** What the decision model is given about one commit (rebaseLeft's diffs, each git's own unified diff). */
export function keptInput({ id, subject = "", paths = [], commit, branch, base, head }) {
  return redactSecrets(
    [
      `Commit ${id.slice(0, 12)}: ${String(subject).slice(0, 200)}`,
      `Files: ${paths.join(", ")}`,
      "",
      "The commit's change (its parent to it):",
      commit || NONE,
      "The branch's whole change before the rebase, on these files:",
      branch || NONE,
      "The default branch's change since the branch split from it, on these files:",
      base || NONE,
      "The rebased branch's change against the default branch's head, on these files:",
      head || NONE,
    ].join("\n").trimEnd(),
  );
}

/**
 * The judge rebaseLeft asks, or null when there is no key (each reshaped commit is then named as dropped).
 * judge(item) resolves {kept, why}: `why` says, when not kept, what the model answered; it never throws.
 */
export function openKeptCheck({ inputs, env = process.env, decider = null }) {
  const key = decider ? null : triageKey({ inputs, env });
  if (!decider && !key) return null;
  mask(key);
  const model = inputs?.triageModel || TRIAGE_MODEL;
  let ask = decider;
  const judge = async (item) => {
    let a;
    try {
      ask ??= await openDecider({ key, model });
      a = await ask.decide(keptInput(item), KEPT_QUESTION);
    } catch (e) {
      log(`rebase check (${model}): the decision model could not be asked: ${String(e?.message || e).slice(0, 160)}`);
      a = { verdict: null, confidence: null, error: "vendor" };
    }
    const conf = typeof a.confidence === "number" ? a.confidence.toFixed(2) : "";
    log(`rebase check (${model}): ${item.id.slice(0, 7)} reshaped by the conflict: ${a.verdict ? `${a.verdict}${conf ? ` ${conf}` : ""}` : `no verdict (${a.error || "?"})`}`);
    if (a.verdict === "kept") return { kept: true, why: "" };
    if (a.verdict === "lost") return { kept: false, why: `the decision model (${model}) judged its change lost${conf ? ` at ${conf}` : ""}` };
    return { kept: false, why: `the decision model gave no answer (${a.error || "no_answer"})` };
  };
  return { model, judge };
}
