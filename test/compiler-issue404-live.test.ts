import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

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
import {
  ManagementOutputError,
  type CompilationContext,
  type CompilerModelAdmission,
  type CompilerProposalCheckpoint,
  type CompilerProposalResult,
} from "../src/management/backend.js";
import type { CompilerRequest } from "../src/compiler/contracts.js";
import { parseAndValidateCompilerProposal } from "../src/compiler/proposal.js";
import { renderCompilerValidationReport } from "../src/compiler/violations.js";
import {
  materializePinnedCompilationTree,
  sealPinnedCompilationTreeProof,
} from "../src/execution/pinned-compilation-tree.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import { pinFixtureRepository } from "./helpers/compiler-proposal.js";

const BASE_TREE = "b".repeat(40);

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
    beforeModelInvocation?: CompilerModelAdmission,
    execution?: CompilationContext,
  ): Promise<CompilerProposalResult> {
    if (request.revision > 0)
      return super.proposePlan(request, checkpoint, beforeModelInvocation, execution);
    const result = await super.proposePlan(
      request,
      async () => {},
      beforeModelInvocation,
      execution,
    );
    const explicit = request.inventory.obligations.filter((entry) => entry.kind === "explicit");
    const omitted = explicit.at(-1)?.id;
    if (!omitted) throw new Error("qualification inventory has no explicit obligation to omit");
    const proposal = structuredClone(result.proposal);
    for (const item of proposal.workItems)
      item.obligationIds = item.obligationIds.filter((id) => id !== omitted);
    const report = parseAndValidateCompilerProposal(request, proposal).report;
    if (!report.violations.some((entry) => entry.code === "unmapped-obligation"))
      throw new Error("qualification omission did not produce unmapped-obligation");
    this.injectedObligationId = omitted;
    const error = new ManagementOutputError(
      new Error(renderCompilerValidationReport(report)),
      result.usage,
      proposal,
    );
    throw Object.assign(error, { validationReport: report });
  }
}

const temporary: string[] = [];
const disposePinnedTrees: Array<() => Promise<void>> = [];
const evidence: Array<Record<string, unknown>> = [];

afterEach(async () => {
  await Promise.all(disposePinnedTrees.splice(0).map((dispose) => dispose()));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

afterAll(() => {
  console.log(
    `ISSUE404_LIVE_EVIDENCE=${JSON.stringify({
      candidateSha: process.env.ISSUE404_CANDIDATE_SHA,
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
  const repository = await mkdtemp(join(tmpdir(), `factory-issue404-${name}-`));
  temporary.push(repository);
  await writeFile(
    join(repository, "package.json"),
    `${JSON.stringify({ name: `issue404-${name}`, private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
  );
  await writeFile(
    join(repository, "package-lock.json"),
    `${JSON.stringify({ name: `issue404-${name}`, lockfileVersion: 3, packages: {} }, null, 2)}\n`,
  );
  await writeFile(
    join(repository, "README.md"),
    "Qualification fixture. Source and test paths named by the Objective are intentionally new.\n",
  );
  const baseSha = pinFixtureRepository(repository);
  const tree = await materializePinnedCompilationTree(repository, baseSha);
  disposePinnedTrees.push(tree.dispose);
  await sealPinnedCompilationTreeProof(tree.proof);
  const context: CompilationContext = {
    repository: tree.path,
    objective: { number: name === "valid-first" ? 4041 : 4042, ...objective },
    defaultBranch: "main",
    baseSha,
    repositoryFiles: tree.files,
    pinnedCompilationTree: tree.proof,
    allowedNetworkDestinations: [],
    runPolicy: {
      ...DEFAULT_RUN_POLICY,
      workItemTimeoutMinutes: 20,
      compilerEvaluation: {
        mode: "auto-repair",
        maxRepairs: 2,
        maxInvocations: 7,
        timeoutSeconds: 3_600,
        maxObservedTokens: 250_000,
      },
    },
    modelSelection: {
      profile: "issue404-qualification",
      model: "gpt-5.6-sol",
      reasoning: "xhigh",
    },
    invocationTimeoutMs: 5 * 60_000,
  };
  context.repositoryEvidence = compilerObligationEvidence(context);
  const store = new MemoryStore(baseSha);
  const leases = new LeaseManager({ store });
  const digest = policyDigest(context.runPolicy);
  const lease = await leases.acquire(
    {
      objective: context.objective.number,
      runId: `issue404-${name}`,
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
  if (result.status !== "accepted") {
    const stopped = {
      name,
      status: result.status,
      reason: result.reason,
      elapsedMilliseconds: Date.now() - started,
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
  const results = result.records.filter((record) => record.kind === "result");
  const usage = results.reduce(
    (total, record) => {
      const observed = record.payload.usage as {
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens?: number;
      } | null;
      if (observed) {
        total.inputTokens += observed.inputTokens;
        total.outputTokens += observed.outputTokens;
        total.cachedInputTokens += observed.cachedInputTokens ?? 0;
      }
      return total;
    },
    { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
  );
  const summary = {
    name,
    sourceBaseSha: baseSha,
    status: result.status,
    acceptedRevision: result.revision,
    graphDigest: result.graphDigest,
    calls: invocations.length,
    stages: invocations.map((record) => `${record.payload.stage}:${record.payload.revision}`),
    usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens },
    elapsedMilliseconds: Date.now() - started,
    terminalRecord: result.records.at(-1)?.kind,
  };
  evidence.push(summary);
  return { result, summary };
}

describe.sequential("issue #404 live semantic compiler qualification", () => {
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
        new CodexCliManagementBackend(),
      );
      expect(summary.acceptedRevision).toBe(0);
      expect(summary.stages).not.toContain("repair:1");
    },
    30 * 60_000,
  );

  it(
    "repairs an explicitly injected omitted-obligation fault",
    async () => {
      const backend = new OmittedObligationBackend();
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
            observed: backend.injectedObligationId,
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
