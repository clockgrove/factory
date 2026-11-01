/**
 * The result reviewer of #2344: the item's own acceptance only, Factory's
 * checks (a mutation pass's survivors, a protected-test check) as
 * evidence, a find call that raises suspicions, a proof of each that
 * writes a repro, and refusals only with a repro its refusal check
 * confirmed. Driven through the build's own entry point,
 * dist/review/item.js `reviewResult`, with the build's planner for the
 * provider and its workspace (`validationWorkspace`), fresh: no earlier
 * review, no prior refusals, no operator decisions. The review runs its
 * workspace's install, its mutation pass and the reviewer call side by
 * side, as Factory's review step does.
 *
 * Set up as production is (`prepare`, once per record, before any
 * review): each item has a warm install store, as Factory's validate step
 * keeps one per item and one per Objective (#2280), filled by one install
 * and given to every review workspace after it. The installation's
 * sandbox, validation and review settings come from the set's
 * `config.json` (read with the build's own `loadConfig`), and the
 * Objective's blocks from the record's `inputs`.
 *
 * Each review's `phases` are the build's own `result-review` event's: the
 * workspace's install (`scratchPrepareMs`), the mutation pass
 * (`mutationMs`), the find calls' commands (`commands`, `commandsMs`,
 * inside the model calls' time), the proofs with their refusal checks
 * (`proofsMs`) and the protected-test check (`protectedMs`). `extra`
 * has the suspicions counted (`raised`, `proved`, `dropped`, the proofs'
 * `tokens`), each one (`suspicionList`, from the build's
 * `result-review-suspicion` events: its criterion, `case`, `expected`,
 * `basis`, `outcome`, the `reason` one was dropped, its repro, commands,
 * tokens and time) and each criterion's examined scenarios (`scenarios`,
 * from `result-review-scenarios`: `criterionIndex`, `structural`,
 * `scenarios` with each one's `verdict`, `holds` or `suspect`).
 *
 * Verdicts are scored at their criterion's index in the record, by its
 * text: a build whose reviewer also judges the Objective criteria the item
 * proves (review/finder.ts) scores those in the objective scope; a
 * criterion the record doesn't list is left out, in `extra.unmapped`.
 *
 * `FIND_ONLY=1` in the environment proves nothing (`review.proofs` 0)
 * and returns each criterion the reviewer suspected as a refusal, its
 * suspicions as the detail: the scorecard's recall and precision are
 * then the find call's alone.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { plannerConfig } from "./v1.mjs";

export const id = "v2";

/** This generation reviews a Work Item in dist/review/item.js. */
export const fits = (_result, build) =>
  existsSync(join(build, "dist/review/item.js"));

/** Its checkouts are its own workspace's (`validationWorkspace`). */
export const needsTree = false;

const MINUTE = 60_000;

async function load(build) {
  const [item, mutants, validate, log, config, selection, facts, engine] =
    await Promise.all(
      [
        "review/item.js",
        "review/mutants.js",
        "validate.js",
        "log.js",
        "config.js",
        "providers/selection.js",
        "planning/facts.js",
        "engine.js",
      ].map((path) => import(join(build, "dist", path))),
    );
  return { item, mutants, validate, log, config, selection, facts, engine };
}

/**
 * The proofs' lanes: each takes a planner slot of the build's host limits,
 * which the service sets from its capacity and the harness never does, so
 * the replay gives the process `PROOF_LANES` (32) of them, shared by its
 * reviews at once.
 */
function proofLanes(factory) {
  const lanes = Number(process.env.PROOF_LANES ?? 32);
  const { caps, reserveMiB, budgetMiB } = factory.engine.hostLimits.usage();
  if (caps.planner < lanes)
    factory.engine.hostLimits.configure({
      caps: { ...caps, planner: lanes },
      reserveMiB,
      budgetMiB,
    });
}

/** The installation's configuration in the set, read as Factory reads it. */
function installation(factory, set) {
  const { repository } = JSON.parse(
    readFileSync(join(set, "config.json"), "utf8"),
  );
  const saved = process.env.FACTORY_CONFIG;
  process.env.FACTORY_CONFIG = join(set, "config.json");
  try {
    return factory.config.loadConfig(repository);
  } finally {
    if (saved === undefined) delete process.env.FACTORY_CONFIG;
    else process.env.FACTORY_CONFIG = saved;
  }
}

/** A run file's growth matters to Factory's run log only. */
const ignore = () => undefined;

/**
 * The validation input of the record's candidate, as Factory's review step
 * builds it, with the item's warm install stores under `cache.shared`.
 */
function validationInput(factory, config, record, at, signal, log) {
  const item = record.plan.items.find((entry) => entry.id === record.item);
  const { candidate } = record;
  const stores = join(at.cache.shared, "packages", String(record.objective));
  mkdirSync(at.files, { recursive: true });
  return {
    checkout: at.checkout,
    repository: config.repository,
    installStore: join(stores, record.item),
    sharedInstallStore: join(stores, "shared"),
    commit: candidate.commit,
    item,
    plan: record.plan,
    blocks: record.inputs.shown.blocks,
    base: candidate.base,
    ...(candidate.base !== record.plan.base
      ? { predecessor: candidate.base }
      : {}),
    media: [],
    sandbox: config.sandbox,
    commandTimeoutMs: config.validation.commandTimeoutSeconds * 1000,
    signal,
    log,
    runFile: (kind) => new factory.log.RunFile(at.files, kind, [], ignore),
  };
}

/**
 * The mutation pass's input as Factory's review step gives it: the item's
 * commands fastest first (`mutantCommands`) by the recorded validation's
 * times, which also bound each mutant.
 */
function mutationOf(factory, item, validation) {
  const own = new Set(ownCommands(factory, item));
  const ms = Object.fromEntries(
    (validation.results ?? [])
      .filter((result) => own.has(result.command) && result.passed)
      .map((result) => [result.command, result.durationMs ?? 0]),
  );
  const times = Object.values(ms);
  return {
    commands: factory.mutants.mutantCommands(item.validation, ms),
    ...(times.length && {
      baselineMs: times.reduce((sum, time) => sum + time, 0),
    }),
    seed: item.id,
  };
}

/** The item's own commands a mutant runs: its validation without the exact install (step-validate.ts). */
function ownCommands(factory, item) {
  const commands = item.validation.map((check) => check.command);
  return commands.length &&
    factory.facts.packageBootstrap(commands[0]) !== undefined
    ? commands.slice(1)
    : commands;
}

/**
 * Before any review of the record: a warm install store, which one
 * install-only checkout fills, or finds warm. Returns `{ installMs }`.
 */
export async function prepare({ build, set, cache, record, checkout, signal }) {
  const factory = await load(build);
  const config = installation(factory, set);
  const at = { checkout, cache, files: join(cache.record, "files") };
  const workspace = factory.item.validationWorkspace(
    validationInput(factory, config, record, at, signal, () => undefined),
    join(cache.record, "prepare-warm"),
  );
  const installed = Date.now();
  await workspace(async () => undefined);
  return { installMs: Date.now() - installed };
}

export async function review({
  build,
  set,
  cache,
  prepared,
  record,
  checkout,
  dir,
  provider,
  signal,
  log,
}) {
  const factory = await load(build);
  const config = installation(factory, set);
  const findOnly = process.env.FIND_ONLY === "1";
  proofLanes(factory);
  const events = [];
  const logged = (event) => {
    events.push(event);
    log(event);
  };
  const at = { checkout, cache, files: join(dir, "files") };
  const item = record.plan.items.find((entry) => entry.id === record.item);
  const { candidate, validation } = record;
  const answer = await factory.item.reviewResult({
    planner: factory.selection.providerPlanner(
      plannerConfig(
        provider,
        factory.selection.defaultModels(provider.planner),
      ),
    ),
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
    dir: join(dir, "review"),
    ...(record.notes ? { notes: record.notes } : {}),
    workspace: factory.item.validationWorkspace(
      validationInput(factory, config, record, at, signal, logged),
      join(dir, "scratch"),
    ),
    // As production gives the validate step's `commandMs`.
    mutation: mutationOf(factory, item, validation),
    limits: {
      mutants: config.review.mutants,
      mutationMs: config.review.mutationSeconds * 1000,
      measuredMutants: config.review.measuredMutants,
      commands: config.review.commands,
      commandBudgetMs: config.review.commandSeconds * 1000,
      proofs: findOnly ? 0 : config.review.proofs,
      proofCommands: config.review.proofCommands,
      proofBudgetMs: config.review.proofSeconds * 1000,
      commandMs: Math.min(
        config.validation.commandTimeoutSeconds * 1000,
        10 * MINUTE,
      ),
      prepareMs: config.validation.commandTimeoutSeconds * 1000 + 5 * MINUTE,
    },
    signal,
    log: logged,
  });
  const suspicionList = events
    .filter((e) => e.event === "result-review-suspicion")
    .map(({ event: _event, step: _step, at: _at, ...entry }) => entry);
  const suspected = (index) =>
    suspicionList.filter((entry) => entry.criterionIndex === index);
  // The build's criteria may run past the item's own (the Objective
  // criteria its review proves): each verdict is scored at its criterion's
  // index in the record, so one on an Objective criterion counts in the
  // objective scope; one the record doesn't list is left out, in `unmapped`.
  const unmapped = [];
  const indexOf = (v) => {
    const index = record.criteria.indexOf(v.criterion);
    if (index < 0) unmapped.push({ criterion: v.criterion, kind: v.kind });
    return index;
  };
  const verdicts = [
    ...answer.verdicts.map((v) =>
      findOnly && suspected(v.criterionIndex).length
        ? {
            criterion: v.criterion,
            kind: "refuse",
            detail: suspected(v.criterionIndex)
              .map((s) => s.case)
              .join("\n"),
          }
        : {
            criterion: v.criterion,
            kind: v.verdict === "note" ? "note" : "pass",
            detail: v.detail,
          },
    ),
    ...(answer.kind === "refused"
      ? answer.refused.map((v) => ({
          criterion: v.criterion,
          kind: "refuse",
          detail: v.detail,
          ...(v.repro ? { repro: v.repro } : {}),
        }))
      : []),
    ...(answer.kind === "pass" ? [] : answer.questions).map((v) => ({
      criterion: v.criterion,
      kind: "question",
      detail: `${v.detail}\n${v.question}`.trim(),
    })),
  ]
    .map(({ criterion, ...v }) => ({
      criterionIndex: indexOf({ criterion, kind: v.kind }),
      ...v,
    }))
    .filter((v) => v.criterionIndex >= 0);
  const tally = events.filter((e) => e.event === "result-review").at(-1);
  const mutation = events.filter((e) => e.event === "mutation-pass").at(-1);
  const phases = tally?.phases;
  return {
    verdicts,
    extra: {
      phases: {
        scratchPrepareMs: phases?.prepareMs ?? null,
        mutationMs: phases?.mutationMs ?? null,
        commands: phases?.commands.count ?? 0,
        commandsMs: phases?.commands.ms ?? 0,
        proofsMs: phases?.proofsMs ?? 0,
        ...(phases?.protectedMs !== undefined && {
          protectedMs: phases.protectedMs,
        }),
      },
      suspicions: tally?.suspicions ?? null,
      suspicionList,
      unmapped,
      scenarios: events
        .filter((e) => e.event === "result-review-scenarios")
        .map(({ event: _event, step: _step, at: _at, ...entry }) => entry),
      repros: tally?.repros ?? null,
      calls: tally?.calls ?? null,
      mutation: mutation
        ? {
            status: mutation.status,
            seeded: mutation.seeded,
            killed: mutation.killed,
            survived: mutation.survived,
            lanes: mutation.lanes,
            ms: mutation.ms,
          }
        : null,
      installMs: prepared.installMs,
    },
  };
}
