/**
 * The result reviewer of #2344: the item's own acceptance only, a mutation
 * pass's survivors as evidence, a reviewer that runs commands in a scratch
 * checkout, and refusals only with a repro its refusal check confirmed.
 * Driven through the build's own entry point, dist/review/item.js
 * `reviewResult`, with the build's planner for the provider, its scratch
 * checkouts (`validationScratch`) and its mutation pass (`mutationPass`),
 * fresh: no earlier review, no prior refusals, no operator decisions.
 *
 * As Factory's validate step does, the mutation pass runs in a validation
 * of the candidate (validate.ts `validateTree`, the item's commands), once
 * per record, shared by its runs. The installation's sandbox, validation
 * and review settings come from the set's `config.json` (an installation
 * configuration, read with the build's own `loadConfig`), and the
 * Objective's blocks from the record's `inputs`.
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

/** Each record's mutation pass, once per process: its runs share it. */
const passes = new Map();

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
function installation(factory, set, repository) {
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

/** The validation input of the record's candidate, as Factory's review step builds it. */
function validationInput(factory, config, record, dir, signal, log) {
  const item = record.plan.items.find((entry) => entry.id === record.item);
  const { candidate } = record;
  return {
    checkout: dir.checkout,
    repository: config.repository,
    installStore: join(dir.packages, record.item),
    sharedInstallStore: join(dir.packages, "shared"),
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
    runFile: (kind) => new factory.log.RunFile(dir.files, kind, [], ignore),
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

/** The record's mutation pass: kept in `cache`, else run in a validation of the candidate. */
async function mutationOf(factory, config, record, dirs, cache, signal) {
  const file = join(cache, "mutation.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const events = [];
  const log = (event) => events.push(event);
  const item = record.plan.items.find((entry) => entry.id === record.item);
  let mutation;
  const started = Date.now();
  const validated = await factory.validate.validateTree({
    ...validationInput(factory, config, record, dirs, signal, log),
    directory: join(dirs.root, "validation"),
    use: async (checkout) => {
      mutation = await factory.mutants.mutationPass({
        checkout,
        repo: checkout.directory,
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
  const pass = mutation ?? {
    status: "skipped",
    note: `The candidate's validation didn't pass in the replay (${validated.kind}${validated.detail ? `: ${String(validated.detail).slice(0, 400)}` : validated.reason ? `: ${validated.reason}` : ""}), so no mutation pass ran.`,
    seeded: 0,
    killed: 0,
    survived: 0,
    survivors: [],
    ms: Date.now() - started,
  };
  mkdirSync(cache, { recursive: true });
  writeFileSync(file, `${JSON.stringify(pass, null, 2)}\n`);
  return pass;
}

export async function review({
  build,
  set,
  cache,
  record,
  checkout,
  dir,
  provider,
  signal,
  log,
}) {
  const factory = await load(build);
  const config = installation(
    factory,
    set,
    JSON.parse(readFileSync(join(set, "config.json"), "utf8")).repository,
  );
  const dirs = {
    root: dir,
    checkout,
    packages: join(cache, "..", "packages"),
    files: join(dir, "files"),
  };
  mkdirSync(dirs.files, { recursive: true });
  if (!passes.has(record.id))
    passes.set(
      record.id,
      mutationOf(factory, config, record, dirs, cache, signal),
    );
  let mutation;
  try {
    mutation = await passes.get(record.id);
  } catch (error) {
    passes.delete(record.id);
    throw error;
  }
  const events = [];
  const logged = (event) => {
    events.push(event);
    log(event);
  };
  const item = record.plan.items.find((entry) => entry.id === record.item);
  const { candidate, validation } = record;
  const scratch = factory.item.validationScratch(
    validationInput(factory, config, record, dirs, signal, logged),
    (name) => join(dir, `scratch-${name}`),
  );
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
      repros: tally?.repros ?? null,
      commands: tally?.commands ?? null,
      calls: tally?.calls ?? null,
      mutation: {
        status: mutation.status,
        seeded: mutation.seeded,
        killed: mutation.killed,
        survived: mutation.survived,
        ms: mutation.ms,
        ...(mutation.note ? { note: mutation.note } : {}),
      },
    },
  };
}
