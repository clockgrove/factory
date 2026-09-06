import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { validateCompiledObjective, type CompilerObjective } from "../compiler/index.js";
import { parsePersistedCompiledObjective } from "../graph.js";
import type {
  CompilationCheckpoint,
  CompilationContext,
  ManagementBackend,
} from "../management/backend.js";
import {
  discoverValidationCommands,
  profileRepository,
  readRepositoryFacts,
} from "../repository-profiles/index.js";

const PathSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/)
  .refine((path) => !path.split("/").some((part) => part === "." || part === ".."));
const IdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const TierSchema = z.enum(["mechanical", "semantic", "visual", "deterministic-simulation"]);
const CriterionSchema = z
  .object({
    id: IdSchema,
    text: z.string().min(20).max(2000),
    paths: z.array(PathSchema).min(1).max(16),
    commands: z.array(z.string().min(1).max(200)).min(1).max(8),
    tiers: z.array(TierSchema).min(1).max(4),
    after: z.array(IdSchema).max(8),
  })
  .strict();
const CaseSchema = z
  .object({
    id: IdSchema,
    kind: z.enum(["typescript", "generated", "binary", "simulation", "visual"]),
    title: z.string().min(1).max(256),
    objective: z.string().min(40).max(8000),
    baseline: z
      .object({ command: z.string().min(1).max(200), stdout: z.string().max(1000) })
      .strict(),
    criteria: z.array(CriterionSchema).min(1).max(8),
    ownership: z
      .array(
        z
          .object({
            source: PathSchema,
            output: PathSchema,
            mergeClass: z.enum(["generated", "large-binary"]),
          })
          .strict(),
      )
      .max(8),
    encodedAssets: z.array(z.object({ source: PathSchema, target: PathSchema }).strict()).max(4),
  })
  .strict();
const CorpusSchema = z
  .object({
    version: z.literal(1),
    limits: z
      .object({ cpu: z.literal(2), memoryMb: z.literal(1024), timeoutMinutes: z.literal(5) })
      .strict(),
    cases: z.array(CaseSchema).length(5),
  })
  .strict();
export type CompilerCorpusCase = z.infer<typeof CaseSchema>;

/** Fixed representative corpus, not an extensible benchmark format. */
export function parseCompilerCorpus(value: unknown) {
  const corpus = CorpusSchema.parse(value);
  if (
    new Set(corpus.cases.map((entry) => entry.id)).size !== 5 ||
    new Set(corpus.cases.map((entry) => entry.kind)).size !== 5
  )
    throw new Error("corpus requires one distinct case of each representative kind");
  for (const entry of corpus.cases) {
    const ids = new Set(entry.criteria.map((criterion) => criterion.id));
    if (ids.size !== entry.criteria.length) throw new Error("duplicate criterion identity");
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error("cyclic criterion prerequisite");
      if (done.has(id)) return;
      const criterion = entry.criteria.find((candidate) => candidate.id === id);
      if (!criterion) throw new Error("unknown criterion prerequisite");
      visiting.add(id);
      criterion.after.forEach(visit);
      visiting.delete(id);
      done.add(id);
    };
    ids.forEach(visit);
    if (
      new Set(entry.encodedAssets.map((asset) => asset.target)).size !== entry.encodedAssets.length
    )
      throw new Error("duplicate decoded asset target");
  }
  return corpus;
}
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const identity = (files: Array<{ path: string; sha256: string }>) => digest(JSON.stringify(files));
const pathOrder = (left: { path: string }, right: { path: string }) =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

/** At most 64 regular files / 1 MiB. Symlinks and oversized inputs fail closed. */
async function fixtureFiles(root: string) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("fixture root must be a real directory");
  const files: Array<{ path: string; bytes: Buffer; sha256: string }> = [];
  let total = 0;
  let entries = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 8) throw new Error("fixture directory depth exceeded");
    for (const name of (await readdir(join(root, relative))).sort()) {
      if (++entries > 128) throw new Error("fixture entry limit exceeded");
      const path = PathSchema.parse(relative ? `${relative}/${name}` : name);
      const info = await lstat(join(root, path));
      if (info.isSymbolicLink()) throw new Error("fixture symlinks are not supported");
      if (info.isDirectory()) await walk(path, depth + 1);
      else {
        if (!info.isFile() || info.size > 256 * 1024 || files.length >= 64)
          throw new Error("fixture file limits exceeded");
        const bytes = await readFile(join(root, path));
        total += bytes.length;
        if (bytes.length > 256 * 1024 || total > 1024 * 1024)
          throw new Error("fixture byte limit exceeded");
        files.push({ path, bytes, sha256: digest(bytes) });
      }
    }
  };
  await walk("", 0);
  return files.sort(pathOrder);
}

/** Owned disposable checkout; never writes into the checked-in corpus. */
export async function prepareCompilerCorpusCase(corpusRoot: string, caseId: string) {
  const manifestPath = join(corpusRoot, "compiler.json");
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 64 * 1024)
    throw new Error("invalid or oversized compiler corpus manifest");
  const manifestBytes = await readFile(manifestPath);
  if (manifestBytes.length > 64 * 1024) throw new Error("compiler corpus manifest too large");
  const corpus = parseCompilerCorpus(JSON.parse(manifestBytes.toString("utf8")));
  const entry = corpus.cases.find((candidate) => candidate.id === caseId);
  if (!entry) throw new Error(`unknown compiler corpus case: ${caseId}`);
  const source = await fixtureFiles(join(corpusRoot, entry.id));
  const files = source.map((file) => ({ ...file }));
  for (const asset of entry.encodedAssets) {
    const file = files.find((candidate) => candidate.path === asset.source);
    if (!file || files.some((candidate) => candidate.path === asset.target))
      throw new Error("missing encoded asset or existing decoded target");
    const encoded = file.bytes.toString("ascii").trim();
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded || bytes.length === 0 || bytes.length > 64 * 1024)
      throw new Error("invalid or oversized encoded fixture asset");
    files.splice(files.indexOf(file), 1, { path: asset.target, bytes, sha256: digest(bytes) });
  }
  files.sort(pathOrder);
  const inventory = files.map(({ path, sha256 }) => ({ path, sha256 }));
  const sourceIdentity = source.map(({ path, sha256 }) => ({ path, sha256 }));
  const repository = await mkdtemp(join(tmpdir(), "factory-compiler-corpus-"));
  try {
    for (const file of files) {
      await mkdir(dirname(join(repository, file.path)), { recursive: true });
      await writeFile(join(repository, file.path), file.bytes, { flag: "wx" });
    }
    const facts = await readRepositoryFacts(
      repository,
      inventory.map((file) => file.path),
    );
    const commands = discoverValidationCommands(facts);
    const paths = new Set(inventory.map((file) => file.path));
    for (const criterion of entry.criteria) {
      if (
        criterion.paths.some((path) => !paths.has(path)) ||
        criterion.commands.some((command) => !commands.includes(command))
      )
        throw new Error("criterion has unobserved paths or ungrounded commands");
    }
    if (!commands.includes(entry.baseline.command)) throw new Error("ungrounded baseline command");
    for (const ownership of entry.ownership) {
      if (!paths.has(ownership.source) || !paths.has(ownership.output))
        throw new Error("unobserved source/output ownership");
    }
    return {
      entry,
      limits: corpus.limits,
      repository,
      facts,
      commands,
      profile: profileRepository(facts),
      inventory,
      fixtureDigest: identity(inventory),
      sourceDigest: identity(sourceIdentity),
      manifestDigest: digest(manifestBytes),
      dispose: () => rm(repository, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(repository, { recursive: true, force: true });
    throw error;
  }
}
export type PreparedCompilerCase = Awaited<ReturnType<typeof prepareCompilerCorpusCase>>;

/** Explicit paid-execution boundary for #112. No default backend, network, or fake usage. */
export async function compilePreparedCorpusCase(
  prepared: PreparedCompilerCase,
  context: Omit<CompilationContext, "repository" | "repositoryFiles" | "objective"> & {
    objectiveNumber: number;
  },
  backend: ManagementBackend,
  checkpoint: CompilationCheckpoint,
) {
  const { objectiveNumber, ...execution } = context;
  if (
    !Number.isSafeInteger(objectiveNumber) ||
    objectiveNumber < 1 ||
    !/^[0-9a-f]{40}$/i.test(context.baseSha)
  )
    throw new Error("explicit Objective identity and base SHA required");
  for (const file of prepared.inventory) {
    const info = await lstat(join(prepared.repository, file.path));
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 256 * 1024 ||
      digest(await readFile(join(prepared.repository, file.path))) !== file.sha256
    )
      throw new Error("prepared fixture changed before compilation");
  }
  return backend.compile(
    {
      ...execution,
      repository: prepared.repository,
      repositoryFiles: prepared.inventory.map((file) => file.path),
      objective: {
        number: objectiveNumber,
        title: prepared.entry.title,
        body: `${prepared.entry.objective}\n\nExecution contract: every Work Item must explicitly set positive cpu <= ${prepared.limits.cpu}, memoryMb <= ${prepared.limits.memoryMb}, and timeoutMinutes <= ${prepared.limits.timeoutMinutes}. Use trusted_local, no services, no network destinations, and no secrets. Provision the declared local tools before execution; do not install dependencies during the offline task.`,
      },
    },
    checkpoint,
  );
}

const BindingSchema = z
  .array(
    z
      .object({
        criterionId: IdSchema,
        // Reviewer-selected references, never guessed from keyword similarity.
        acceptance: z
          .array(
            z.object({ workItemId: IdSchema, index: z.number().int().min(0).max(63) }).strict(),
          )
          .min(1)
          .max(32),
        rationale: z.string().min(20).max(2000),
      })
      .strict(),
  )
  .min(1)
  .max(8);
export type CompilerCriterionBindings = z.infer<typeof BindingSchema>;

/** Structural coverage only; criterion meaning and reviewer rationale still require semantic review. */
export function assessCompilerCorpusResult(
  prepared: PreparedCompilerCase,
  input: unknown,
  bindingsInput: unknown,
  baseSha: string,
) {
  const objective = parsePersistedCompiledObjective(input) as CompilerObjective;
  if (
    objective.workItems.some(
      (item) =>
        !item.context ||
        !item.changeSurface ||
        !item.validation ||
        !item.delivery ||
        !item.economicReview,
    )
  )
    throw new Error("compiler corpus requires complete enriched compiler output");
  validateCompiledObjective(objective, prepared.facts);
  for (const item of objective.workItems) {
    if (
      item.requirements.networkDestinations.length ||
      item.requirements.permittedSecretNames.length ||
      item.requirements.services.length ||
      item.requirements.trust !== "trusted_local"
    )
      throw new Error(
        "offline fixture cannot request services, secrets, network, or a different trust boundary",
      );
    for (const key of ["cpu", "memoryMb", "timeoutMinutes"] as const) {
      const value = item.requirements[key];
      if (typeof value !== "number" || value <= 0 || value > prepared.limits[key])
        throw new Error(`missing or excessive corpus resource requirement: ${key}`);
    }
    const observed = new Set(prepared.inventory.map((file) => file.path));
    if (item.context!.mustRead.some((path) => !observed.has(path) && !item.scope.includes(path)))
      throw new Error("unobserved and unscoped context path");
  }
  if (
    objective.title !== prepared.entry.title ||
    objective.workItems.some((item) => item.baseSha !== baseSha)
  )
    throw new Error("compiled Objective identity does not match fixture run");
  const bindings = BindingSchema.parse(bindingsInput);
  if (
    bindings.length !== prepared.entry.criteria.length ||
    new Set(bindings.map((binding) => binding.criterionId)).size !== bindings.length
  )
    throw new Error("criterion bindings must cover every criterion exactly once");
  const byId = new Map(objective.workItems.map((item) => [item.id, item]));
  const owners = new Map<string, string[]>();
  const covers = (scope: string[], path: string) =>
    scope.some((value) => value === path || (value.endsWith("/") && path.startsWith(value)));
  for (const binding of bindings) {
    const criterion = prepared.entry.criteria.find(
      (candidate) => candidate.id === binding.criterionId,
    );
    if (!criterion) throw new Error("unknown criterion binding");
    const ids = [...new Set(binding.acceptance.map((reference) => reference.workItemId))];
    for (const reference of binding.acceptance) {
      if (!byId.get(reference.workItemId)?.acceptance[reference.index])
        throw new Error("missing bound acceptance reference");
    }
    const items = ids.map((id) => byId.get(id)!);
    if (
      criterion.paths.some((path) => !items.some((item) => covers(item.scope, path))) ||
      criterion.commands.some(
        (command) => !items.some((item) => item.validationCommands.includes(command)),
      ) ||
      criterion.tiers.some(
        (tier) =>
          !items.some((item) => item.validation?.some((validation) => validation.tier === tier)),
      )
    )
      throw new Error(`uncovered compiler properties for criterion ${criterion.id}`);
    owners.set(criterion.id, ids);
  }
  const precedes = (before: string, after: string): boolean => {
    const pending = [after];
    const seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === before) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...byId.get(id)!.dependsOn);
    }
    return false;
  };
  for (const criterion of prepared.entry.criteria) {
    for (const prerequisite of criterion.after) {
      if (
        !owners
          .get(criterion.id)!
          .every((after) => owners.get(prerequisite)!.every((before) => precedes(before, after)))
      )
        throw new Error(`missing criterion prerequisite: ${prerequisite} -> ${criterion.id}`);
    }
  }
  for (const ownership of prepared.entry.ownership) {
    const sources = objective.workItems.filter((item) => covers(item.scope, ownership.source));
    const outputs = objective.workItems.filter((item) => covers(item.scope, ownership.output));
    if (
      !sources.length ||
      !outputs.length ||
      outputs.some(
        (output) =>
          output.changeSurface!.mergeClass !== ownership.mergeClass ||
          !output.changeSurface!.exclusiveResources.includes(ownership.output) ||
          !sources.some((source) => precedes(source.id, output.id)),
      )
    )
      throw new Error("missing source/output ownership, resource, or ordering");
  }
  return {
    level: "compiler-corpus-structural" as const,
    fixtureDigest: prepared.fixtureDigest,
    manifestDigest: prepared.manifestDigest,
    objectiveDigest: digest(JSON.stringify(objective)),
    bindingsDigest: digest(JSON.stringify(bindings)),
    criteria: [...owners.keys()],
    semanticReviewRequired: true as const,
    installedExecutionProven: false as const,
    economicBenefitMeasured: false as const,
  };
}
