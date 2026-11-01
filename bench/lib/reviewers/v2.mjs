/**
 * The result reviewer of #2344: the item's own acceptance only, a mutation
 * pass's survivors as evidence, a reviewer that runs commands in a scratch
 * checkout, and refusals only with a repro its refusal check confirmed.
 * Driven through the build's own entry point, dist/review/item.js
 * `reviewResult`, with the build's planner for the provider, its scratch
 * checkouts (`validationScratch`) and its mutation pass (`mutationPass`),
 * fresh: no earlier review, no prior refusals, no operator decisions.
 *
 * Set up as production is (`prepare`, once per record, before any
 * review): each item has a warm install store, as Factory's validate step
 * keeps one per item and one per Objective (#2280), filled by one install
 * and given to every validation, scratch checkout and repro check after
 * it, so each install there takes what a warm one takes. The mutation
 * pass runs, as the validate step runs it, in a validation of the
 * candidate (`validateTree`, the item's commands), kept per record for its
 * runs. The installation's sandbox, validation and review settings come
 * from the set's `config.json` (read with the build's own `loadConfig`),
 * and the Objective's blocks from the record's `inputs`.
 *
 * Each review's `phases`: the mutation pass it is given (`mutationMs`),
 * making its scratch checkouts (`scratchPrepareMs`, `scratchCheckouts`),
 * the reviewer's commands (`commands`, `commandsMs`, which run inside the
 * model call's time) and the repro checks (`repros`, `reprosMs`, each with
 * its checkout).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plannerConfig } from "./v1.mjs";

export const id = "v2";

/** This generation reviews a Work Item in dist/review/item.js. */
export const fits = (_result, build) =>
  existsSync(join(build, "dist/review/item.js"));

/** Its scratch checkouts are its own (`validationScratch`). */
export const needsTree = false;

const MINUTE = 60_000;

async function load(build) {
  const [item, mutants, validate, log, config, selection, facts] =
    await Promise.all(
      [
        "review/item.js",
        "review/mutants.js",
        "validate.js",
        "log.js",
        "config.js",
        "providers/selection.js",
        "planning/facts.js",
      ].map((path) => import(join(build, "dist", path))),
    );
  return { item, mutants, validate, log, config, selection, facts };
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

/** The item's own commands a mutant runs: its validation without the exact install (step-validate.ts). */
function ownCommands(factory, item) {
  const commands = item.validation.map((check) => check.command);
  return commands.length &&
    factory.facts.packageBootstrap(commands[0]) !== undefined
    ? commands.slice(1)
    : commands;
}

/**
 * Before any review of the record: a warm install store (one install-only
 * checkout fills it, or finds it warm), then the mutation pass, kept in
 * `cache.record` across invocations. Returns `{ mutation, installMs }`.
 */
export async function prepare({ build, set, cache, record, checkout, signal }) {
  const factory = await load(build);
  const config = installation(factory, set);
  const at = { checkout, cache, files: join(cache.record, "files") };
  const item = record.plan.items.find((entry) => entry.id === record.item);
  const log = () => undefined;
  const scratch = factory.item.validationScratch(
    validationInput(factory, config, record, at, signal, log),
    (name) => join(cache.record, `prepare-${name}`),
  );
  const installed = Date.now();
  await scratch("warm", async () => undefined);
  const installMs = Date.now() - installed;
  const file = join(cache.record, "mutation.json");
  if (existsSync(file))
    return { mutation: JSON.parse(readFileSync(file, "utf8")), installMs };
  let mutation;
  const started = Date.now();
  const validated = await factory.validate.validateTree({
    ...validationInput(factory, config, record, at, signal, log),
    directory: join(cache.record, "prepare-validation"),
    use: async (validatedCheckout) => {
      mutation = await factory.mutants.mutationPass({
        checkout: validatedCheckout,
        repo: validatedCheckout.directory,
        base: record.candidate.base,
        commit: "HEAD",
        commands: ownCommands(factory, item),
        limits: {
          max: config.review.mutants,
          ms: config.review.mutationSeconds * 1000,
        },
        seed: item.id,
        signal,
        log,
      });
    },
  });
  mutation ??= {
    status: "skipped",
    note: `The candidate's validation didn't pass in the replay (${validated.kind}: ${String(validated.detail ?? validated.reason ?? validated.question ?? "").slice(0, 400)}), so no mutation pass ran.`,
    seeded: 0,
    killed: 0,
    survived: 0,
    survivors: [],
    ms: Date.now() - started,
  };
  writeFileSync(file, `${JSON.stringify(mutation, null, 2)}\n`);
  return { mutation, installMs };
}

/** `scratch`, timing how long each checkout takes to make and each command in it runs. */
function timedScratch(scratch, phases) {
  return (name, use) => {
    const asked = Date.now();
    return scratch(name, (checkout) => {
      phases.scratchCheckouts += 1;
      phases.scratchPrepareMs += Date.now() - asked;
      const run = async (command, ms) => {
        const started = Date.now();
        try {
          return await checkout.run(command, ms);
        } finally {
          const took = Date.now() - started;
          if (name === "repro") {
            phases.repros += 1;
            phases.reprosMs += took;
          } else {
            phases.commands += 1;
            phases.commandsMs += took;
          }
        }
      };
      return use(
        new Proxy(checkout, {
          get: (target, key) =>
            key === "run" ? run : Reflect.get(target, key, target),
        }),
      );
    });
  };
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
  const { mutation } = prepared;
  const events = [];
  const logged = (event) => {
    events.push(event);
    log(event);
  };
  const phases = {
    mutationMs: mutation.ms,
    scratchCheckouts: 0,
    scratchPrepareMs: 0,
    commands: 0,
    commandsMs: 0,
    repros: 0,
    reprosMs: 0,
  };
  const at = { checkout, cache, files: join(dir, "files") };
  const scratch = timedScratch(
    factory.item.validationScratch(
      validationInput(factory, config, record, at, signal, logged),
      (name) => join(dir, `scratch-${name}`),
    ),
    phases,
  );
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
    scratch,
    ...(mutation.status === "skipped" && !mutation.seeded ? {} : { mutation }),
    commandMs: Math.min(
      config.validation.commandTimeoutSeconds * 1000,
      10 * MINUTE,
    ),
    signal,
    log: logged,
  });
  const verdicts = [
    ...answer.verdicts.map((v) => ({
      criterionIndex: v.criterionIndex,
      kind: v.verdict === "note" ? "note" : "pass",
      detail: v.detail,
    })),
    ...(answer.kind === "refused"
      ? answer.refused.map((v) => ({
          criterionIndex: v.criterionIndex,
          kind: "refuse",
          detail: v.detail,
          ...(v.repro ? { repro: v.repro } : {}),
        }))
      : []),
    ...(answer.kind === "pass" ? [] : answer.questions).map((v) => ({
      criterionIndex: v.criterionIndex,
      kind: "question",
      detail: `${v.detail}\n${v.question}`.trim(),
    })),
  ];
  const tally = events.filter((e) => e.event === "result-review").at(-1);
  return {
    verdicts,
    extra: {
      phases,
      repros: tally?.repros ?? null,
      calls: tally?.calls ?? null,
      mutation: {
        status: mutation.status,
        seeded: mutation.seeded,
        killed: mutation.killed,
        survived: mutation.survived,
        ms: mutation.ms,
        ...(mutation.note ? { note: mutation.note } : {}),
      },
      installMs: prepared.installMs,
    },
  };
}
