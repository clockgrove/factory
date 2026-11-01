/**
 * The result reviewer up to #2344: one read-only review of every criterion
 * the plan gives the item (`resultCriteria`), each `pass`, `refuse` or
 * `needs-human`. Driven through the build's own entry point,
 * dist/review/result.js `reviewResult`, with the build's planner for the
 * provider (dist/providers/selection.js `providerPlanner`), fresh: no
 * retained conversation, no operator decisions and no earlier review.
 */
import { join } from "node:path";

export const id = "v1";

/** This generation exports `commandProofs`, which #2344 removes. */
export const fits = (result) =>
  typeof result.reviewResult === "function" &&
  typeof result.commandProofs === "function";

/** It reads the candidate from Git, so it needs no checkout of its own. */
export const needsTree = false;

/**
 * The provider configuration for `providerPlanner`: the build's defaults
 * (`defaults`, its `defaultModels`), with the model and effort given.
 */
export function plannerConfig({ planner, model, effort }, defaults) {
  const reviewer = {
    model: model ?? defaults.reviewer.model,
    effort: effort ?? defaults.reviewer.effort,
  };
  return {
    planner,
    models: {
      ...(model || effort ? { reviewer } : {}),
      ...(effort ? { reviewEffort: { "result-review": effort } } : {}),
    },
    worker: { kind: "codex", network: "off" },
  };
}

export async function review({
  build,
  record,
  checkout,
  dir,
  provider,
  signal,
  log,
}) {
  const { reviewResult } = await import(join(build, "dist/review/result.js"));
  const { providerPlanner, defaultModels } = await import(
    join(build, "dist/providers/selection.js")
  );
  const config = plannerConfig(provider, defaultModels(provider.planner));
  const item = record.plan.items.find((entry) => entry.id === record.item);
  const { candidate, validation } = record;
  const answer = await reviewResult({
    planner: providerPlanner(config),
    plan: record.plan,
    item,
    checkout,
    base: candidate.base,
    commit: candidate.commit,
    validation: {
      tree: validation.tree,
      commands: validation.commands,
      ...(validation.formatted ? { formatted: validation.formatted } : {}),
    },
    sources: record.sources,
    dir,
    ...(record.notes ? { notes: record.notes } : {}),
    signal,
    log,
  });
  const verdicts = [
    ...answer.verdicts.map((v) => ({
      criterionIndex: v.criterionIndex,
      kind: "pass",
      detail: v.detail,
    })),
    ...(answer.kind === "refused"
      ? answer.refused.map((v) => ({
          criterionIndex: v.criterionIndex,
          kind: "refuse",
          detail: v.detail,
        }))
      : []),
    ...(answer.kind === "pass" ? [] : answer.questions).map((v) => ({
      criterionIndex: v.criterionIndex,
      kind: "question",
      detail: `${v.detail}\n${v.question}`.trim(),
    })),
  ];
  return { verdicts };
}
