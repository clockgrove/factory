import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { CompilerDraftManager } from "../src/control/compiler-drafts.js";
import type { CompiledGraphStore } from "../src/control/graphs.js";
import { LeaseManager, type GitCommitObject, type LeaseStore } from "../src/control/lease.js";
import { compilerEvalDigest } from "../src/evaluation/compiler-eval.js";
import {
  assertCompilerDraftSelection,
  compileEvaluatedDraft,
} from "../src/management/draft-compilation.js";
import {
  CodexCliManagementBackend,
  compilerObligationEvidence,
} from "../src/management/codex-cli.js";
import { LocalManagementTranscriptRecorder } from "../src/management/transcripts.js";
import {
  ManagementOutputError,
  type CompilationContext,
  type CompilerModelAdmission,
  type CompilerProposalCheckpoint,
  type CompilerProposalResult,
} from "../src/management/backend.js";
import type { CompilerRequest } from "../src/compiler/contracts.js";
import {
  parseAndValidateCompilerProposal,
  type CompilerProjectionContext,
} from "../src/compiler/proposal.js";
import { renderCompilerValidationReport } from "../src/compiler/violations.js";
import {
  materializePinnedCompilationTree,
  sealPinnedCompilationTreeProof,
} from "../src/execution/pinned-compilation-tree.js";
import { policyDigest } from "../src/protocol/policy.js";
import { pinFixtureRepository } from "./helpers/compiler-proposal.js";
import {
  issue404AggregateTokenUsage,
  assertIssue404CanonicalFixture,
  issue404CanonicalPath,
  issue404LiveAuthority,
  issue404QualificationCompilationContext,
  issue404TerminalTranscriptEvidence,
  issue404TokenUsageByStage,
  type Issue404DurableRecord,
  type Issue404LiveAuthority,
  type Issue404ResponseTransformation,
} from "./helpers/issue404-live-authority.js";

const BASE_TREE = "b".repeat(40);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = process.env.FACTORY_LIVE_COMPILER_ISSUE404 === "1";

let authority: Issue404LiveAuthority | undefined;

function inspectLiveCandidate(candidateSha: string) {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: REPOSITORY_ROOT, encoding: "utf8" }).trim();
  return {
    candidateCommitSha: git("rev-parse", "--verify", `${candidateSha}^{commit}`),
    headSha: git("rev-parse", "--verify", "HEAD"),
    worktreeStatus: git("status", "--porcelain", "--untracked-files=all"),
  };
}

function assertWritableTranscriptDirectory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const details = lstatSync(directory);
  if (!details.isDirectory() || details.isSymbolicLink())
    throw new Error("the live transcript archive must be a real directory");
  accessSync(directory, fsConstants.R_OK | fsConstants.W_OK);
  const marker = join(directory, `.factory-issue404-preflight-${process.pid}`);
  try {
    writeFileSync(marker, "write-probe\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  } finally {
    try {
      unlinkSync(marker);
    } catch {}
  }
}

function transcriptRecorder() {
  if (!authority) throw new Error("live compiler authority was not established");
  return new LocalManagementTranscriptRecorder(authority.transcriptDirectory);
}

class MemoryStore implements LeaseStore, CompiledGraphStore {
  readonly now = new Date("2026-09-15T18:00:00.000Z");
  readonly refs = new Map<string, string>();
  readonly commits = new Map<string, GitCommitObject>();
  readonly blobs = new Map<string, Buffer>();
  readonly trees = new Map<string, Map<string, string>>();
  next = 1;

  constructor(baseSha: string) {
    this.commits.set(baseSha, {
      oid: baseSha,
      treeOid: BASE_TREE,
      parentOids: [],
      message: "base",
      serverTime: this.now,
    });
    this.trees.set(BASE_TREE, new Map());
  }

  #oid() {
    return (this.next++).toString(16).padStart(40, "0");
  }

  async readRef(ref: string) {
    return this.refs.get(ref) ?? null;
  }

  async readCommit(oid: string) {
    const commit = this.commits.get(oid);
    if (!commit) throw new Error(`missing commit ${oid}`);
    return commit;
  }

  async createCommit(args: { treeOid: string; parentOids: string[]; message: string }) {
    const oid = this.#oid();
    this.commits.set(oid, { oid, ...args, serverTime: this.now });
    return oid;
  }

  async createRef(ref: string, oid: string) {
    if (this.refs.has(ref)) return false;
    this.refs.set(ref, oid);
    return true;
  }

  async compareAndSwapRef(args: { ref: string; beforeOid: string; afterOid: string }) {
    if (this.refs.get(args.ref) !== args.beforeOid) return false;
    this.refs.set(args.ref, args.afterOid);
    return true;
  }

  async serverTime() {
    return this.now;
  }

  async createBlob(content: Buffer) {
    const oid = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
    this.blobs.set(oid, Buffer.from(content));
    return oid;
  }

  async readBlob(oid: string) {
    const blob = this.blobs.get(oid);
    if (!blob) throw new Error(`missing blob ${oid}`);
    return Buffer.from(blob);
  }

  async createTree(args: {
    baseTreeOid?: string;
    entries: Array<{
      path: string;
      mode: "100644" | "100755" | "120000";
      type: "blob";
      sha: string | null;
    }>;
  }) {
    const tree = new Map(args.baseTreeOid ? (this.trees.get(args.baseTreeOid) ?? []) : []);
    for (const entry of args.entries) {
      if (entry.sha) tree.set(entry.path, entry.sha);
      else tree.delete(entry.path);
    }
    const oid = this.#oid();
    this.trees.set(oid, tree);
    return oid;
  }

  async readTreeEntry(treeOid: string, path: string) {
    return this.trees.get(treeOid)?.get(path) ?? null;
  }
}

/** The initial candidate is produced by the real backend. This qualification-only
 * boundary then removes one authenticated obligation mapping and requires the
 * subsequent real repair invocation to restore it. */
class OmittedObligationBackend extends CodexCliManagementBackend {
  injectedObligationId: string | null = null;

  override async proposePlan(
    request: CompilerRequest,
    checkpoint: CompilerProposalCheckpoint,
    projection: CompilerProjectionContext,
    beforeModelInvocation?: CompilerModelAdmission,
    execution?: CompilationContext,
  ): Promise<CompilerProposalResult> {
    if (request.revision > 0)
      return super.proposePlan(request, checkpoint, projection, beforeModelInvocation, execution);
    const result = await super.proposePlan(
      request,
      async () => {},
      projection,
      beforeModelInvocation,
      execution,
    );
    const explicit = request.inventory.obligations.filter((entry) => entry.kind === "explicit");
    const omitted = explicit.at(-1)?.id;
    if (!omitted) throw new Error("qualification inventory has no explicit obligation to omit");
    const proposal = structuredClone(result.proposal);
    for (const item of proposal.workItems)
      item.obligationIds = item.obligationIds.filter((id) => id !== omitted);
    const report = parseAndValidateCompilerProposal(request, proposal, projection).report;
    if (!report.violations.some((entry) => entry.code === "unmapped-obligation"))
      throw new Error("qualification omission did not produce unmapped-obligation");
    this.injectedObligationId = omitted;
    const error = new ManagementOutputError(
      new Error(renderCompilerValidationReport(report)),
      result.usage,
      proposal,
    );
    const { promptDigest, schemaDigest, baseSha, model, reasoning } = result.provenance;
    throw Object.assign(error, {
      validationReport: report,
      provenance: { promptDigest, schemaDigest, baseSha, model, reasoning },
    });
  }
}

const temporary: string[] = [];
const disposePinnedTrees: Array<() => Promise<void>> = [];
const evidence: Array<Record<string, unknown>> = [];

async function assertTerminalTranscripts(
  records: readonly Issue404DurableRecord[],
  expectation: {
    invocationIds: readonly string[];
    durableRunId: string;
    baseSha: string;
    canonicalCwd: string;
    notBeforeMs: number;
    preexistingFiles: ReadonlySet<string>;
    forbiddenPromptFragments?: readonly string[];
    responseTransformations?: readonly Issue404ResponseTransformation[];
  },
) {
  if (!authority) throw new Error("live compiler authority was not established");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const files = (await readdir(authority.transcriptDirectory)).filter(
      (file) => file.startsWith("factory-management-") && file.endsWith(".json"),
    );
    const transcripts = await Promise.all(
      files.map(async (file) => ({
        file,
        record: await readFile(join(authority!.transcriptDirectory, file), "utf8")
          .then((body) => JSON.parse(body) as unknown)
          .catch(() => null),
      })),
    );
    const matched = issue404TerminalTranscriptEvidence(transcripts, records, {
      ...expectation,
      observedAtMs: Date.now(),
      transport: "codex-cli-jsonl",
      profile: null,
    });
    if (matched) return matched;
    await delay(25);
  }
  throw new Error(
    `live transcript archive lacks bound terminal records for ${expectation.invocationIds.join(", ")}`,
  );
}

function documentedResponseTransformations(
  backend: CodexCliManagementBackend,
): Issue404ResponseTransformation[] {
  if (!(backend instanceof OmittedObligationBackend) || !backend.injectedObligationId) return [];
  return [
    {
      stage: "compile",
      revision: 0,
      kind: "omit-obligation",
      obligationId: backend.injectedObligationId,
    },
  ];
}

afterEach(async () => {
  await Promise.all(disposePinnedTrees.splice(0).map((dispose) => dispose()));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

afterAll(() => {
  console.log(
    `ISSUE404_LIVE_EVIDENCE=${JSON.stringify({
      candidateSha: authority?.candidateSha ?? null,
      qualificationRunId: authority?.runId ?? null,
      model: "gpt-5.6-sol",
      reasoning: "xhigh",
      cases: evidence,
    })}`,
  );
});

async function qualify(
  name: string,
  objective: { title: string; body: string },
  backend: CodexCliManagementBackend,
) {
  if (!authority) throw new Error("live compiler authority was not established");
  const preexistingTranscriptFiles = new Set(await readdir(authority.transcriptDirectory));
  const transcriptNotBeforeMs = Date.now();
  const repository = await mkdtemp(join(tmpdir(), `factory-issue404-${name}-`));
  temporary.push(repository);
  const fixtureFiles = [
    {
      path: "package.json",
      content: `${JSON.stringify({ name: `issue404-${name}`, private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
    },
    {
      path: "package-lock.json",
      content: `${JSON.stringify({ name: `issue404-${name}`, lockfileVersion: 3, packages: {} }, null, 2)}\n`,
    },
    {
      path: "README.md",
      content:
        "Qualification fixture. Source and test paths named by the Objective are intentionally new.\n",
    },
  ];
  await Promise.all(
    fixtureFiles.map((file) => writeFile(join(repository, file.path), file.content)),
  );
  const authorityMarkerPath = ".factory-issue404-qualification.json";
  const baseSha = pinFixtureRepository(repository, {
    commitDate: "2000-01-01T00:00:00.000Z",
  });
  const tree = await materializePinnedCompilationTree(repository, baseSha);
  disposePinnedTrees.push(tree.dispose);
  const fixtureManifest = await assertIssue404CanonicalFixture({
    tree,
    baseSha,
    files: fixtureFiles,
    forbiddenPaths: [authorityMarkerPath],
  });
  await sealPinnedCompilationTreeProof(tree.proof);
  const canonicalCwd = issue404CanonicalPath(tree.path);
  const context = issue404QualificationCompilationContext({
    repository: tree.path,
    objective: { number: name === "valid-first" ? 4041 : 4042, ...objective },
    baseSha,
    repositoryFiles: tree.files,
    pinnedCompilationTree: tree.proof,
  });
  context.repositoryEvidence = compilerObligationEvidence(context);
  const forbiddenAuthorityFragments = [
    authorityMarkerPath,
    authority.candidateSha,
    authority.runId,
  ];
  const repositoryEvidence = JSON.stringify(context.repositoryEvidence);
  if (forbiddenAuthorityFragments.some((fragment) => repositoryEvidence.includes(fragment)))
    throw new Error("live qualification authority metadata entered model evidence");
  const store = new MemoryStore(baseSha);
  const leases = new LeaseManager({ store });
  const digest = policyDigest(context.runPolicy);
  const lease = await leases.acquire(
    {
      objective: context.objective.number,
      runId: `${authority.runId}-${name}`,
      holder: "qualification",
      policyDigest: digest,
    },
    await store.readCommit(baseSha),
  );
  const manager = new CompilerDraftManager(store, leases);
  const started = Date.now();
  const result = await compileEvaluatedDraft({
    context,
    backend,
    manager,
    lease,
    binding: {
      repository: "clockgrove/factory",
      objective: context.objective.number,
      runId: lease.runId,
      policyDigest: digest,
      baseSha,
      inputDigest: compilerEvalDigest(context.objective),
    },
    admit: async () => {},
    recordUsage: async () => {},
    assertInputs: async () => {},
    validate: async () => {},
    deadlineAt: Date.now() + 60 * 60_000,
  });
  const responseTransformations = documentedResponseTransformations(backend);
  const scenarioSpec = {
    protocol: "clockgrove.factory/compiler-qualification-scenario-v1",
    fixture: {
      baseSha,
      files: fixtureManifest,
    },
    objective: context.objective,
    allowedNetworkDestinations: context.allowedNetworkDestinations,
    runPolicy: context.runPolicy,
    modelSelection: context.modelSelection,
    responseTransformations,
  };
  const scenarioDigest = compilerEvalDigest(scenarioSpec);
  if (result.status !== "accepted") {
    const invocationIds = result.records
      .filter((record) => record.kind === "invocation")
      .map((record) => String(record.payload.invocationId));
    const transcripts = await assertTerminalTranscripts(result.records, {
      invocationIds,
      durableRunId: lease.runId,
      baseSha,
      canonicalCwd,
      notBeforeMs: transcriptNotBeforeMs,
      preexistingFiles: preexistingTranscriptFiles,
      forbiddenPromptFragments: forbiddenAuthorityFragments,
      responseTransformations,
    });
    const stopped = {
      name,
      scenarioSpec,
      scenarioDigest,
      qualificationRunId: authority.runId,
      durableRunId: lease.runId,
      candidateSha: authority.candidateSha,
      sourceBaseSha: baseSha,
      status: result.status,
      reason: result.reason,
      elapsedMilliseconds: Date.now() - started,
      invocationIds,
      transcripts,
      tokenUsageByStage: issue404TokenUsageByStage(result.records),
      usage: issue404AggregateTokenUsage(result.records),
      records: result.records.map((record) => ({
        kind: record.kind,
        sequence: record.sequence,
        stage: record.payload.stage,
        revision: record.payload.revision,
        error: record.payload.error,
        stopReason: record.payload.stopReason,
        validationStatus:
          record.payload.validationReport && typeof record.payload.validationReport === "object"
            ? (record.payload.validationReport as { status?: unknown }).status
            : undefined,
        violationCodes:
          record.payload.validationReport && typeof record.payload.validationReport === "object"
            ? (
                (record.payload.validationReport as { violations?: Array<{ code?: unknown }> })
                  .violations ?? []
              ).map((entry) => entry.code)
            : [],
      })),
    };
    evidence.push(stopped);
    throw new Error(`qualification stopped: ${JSON.stringify(stopped)}`);
  }
  expect(() => assertCompilerDraftSelection(result.records, result.graph)).not.toThrow();
  const invocations = result.records.filter((record) => record.kind === "invocation");
  const invocationIds = invocations.map((record) => String(record.payload.invocationId));
  const transcripts = await assertTerminalTranscripts(result.records, {
    invocationIds,
    durableRunId: lease.runId,
    baseSha,
    canonicalCwd,
    notBeforeMs: transcriptNotBeforeMs,
    preexistingFiles: preexistingTranscriptFiles,
    forbiddenPromptFragments: forbiddenAuthorityFragments,
    responseTransformations,
  });
  const summary = {
    name,
    scenarioSpec,
    scenarioDigest,
    qualificationRunId: authority.runId,
    durableRunId: lease.runId,
    candidateSha: authority.candidateSha,
    sourceBaseSha: baseSha,
    status: result.status,
    acceptedRevision: result.revision,
    graphDigest: result.graphDigest,
    calls: invocations.length,
    invocationIds,
    transcripts,
    stages: invocations.map((record) => `${record.payload.stage}:${record.payload.revision}`),
    tokenUsageByStage: issue404TokenUsageByStage(result.records),
    usage: issue404AggregateTokenUsage(result.records),
    elapsedMilliseconds: Date.now() - started,
    terminalRecord: result.records.at(-1)?.kind,
  };
  evidence.push(summary);
  return { result, summary };
}

describe.skipIf(!LIVE).sequential("issue #404 live semantic compiler qualification", () => {
  beforeAll(() => {
    authority = issue404LiveAuthority(
      process.env,
      REPOSITORY_ROOT,
      inspectLiveCandidate,
      assertWritableTranscriptDirectory,
      issue404CanonicalPath,
    );
  });
  it(
    "accepts a mechanically valid first draft without repair",
    async () => {
      const { summary } = await qualify(
        "valid-first",
        {
          title: "Add deterministic slug normalization",
          body: [
            "Add src/slug.js exporting normalizeSlug(input), which returns a string.",
            "The function trims leading and trailing whitespace, lowercases ASCII letters, replaces each nonempty run of internal whitespace with one hyphen, and leaves all other characters unchanged.",
            "Add test/slug.test.js with assertions for trimming, ASCII case conversion, and multi-character whitespace runs.",
            "Keep the package private and do not add runtime dependencies.",
          ].join("\n"),
        },
        new CodexCliManagementBackend({ transcriptRecorder: transcriptRecorder() }),
      );
      expect(summary.acceptedRevision).toBe(0);
      expect(summary.stages).not.toContain("repair:1");
    },
    30 * 60_000,
  );

  it(
    "repairs an explicitly injected omitted-obligation fault",
    async () => {
      const backend = new OmittedObligationBackend({ transcriptRecorder: transcriptRecorder() });
      const { result, summary } = await qualify(
        "omitted-obligation-repair",
        {
          title: "Add strict TCP port parsing",
          body: [
            "Add src/port.js exporting parsePort(input), which returns a number.",
            "Accept only decimal digit strings representing values from 1 through 65535 inclusive and return the numeric value.",
            "Reject zero, values above 65535, signs, decimals, surrounding whitespace, and nondigits by throwing RangeError.",
            "Add test/port.test.js covering accepted boundaries and every rejected input class.",
            "Keep the existing package public API and dependency set unchanged.",
          ].join("\n"),
        },
        backend,
      );
      expect(backend.injectedObligationId).not.toBeNull();
      expect(summary.acceptedRevision).toBeGreaterThan(0);
      expect(summary.stages).toContain("repair:1");
      const initial = result.records.find(
        (record) => record.kind === "result" && record.payload.stage === "compile",
      );
      expect(initial?.payload.validationReport).toMatchObject({
        status: "repairable",
        violations: expect.arrayContaining([
          expect.objectContaining({
            code: "unmapped-obligation",
            expected: backend.injectedObligationId,
            observed: null,
          }),
        ]),
      });
      Object.assign(evidence.at(-1)!, {
        injectedFault: "removed one explicit obligation mapping from the live initial proposal",
        injectedObligationId: backend.injectedObligationId,
        repairObserved: true,
      });
    },
    30 * 60_000,
  );
});
