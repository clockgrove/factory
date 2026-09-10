import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withVerifiedReviewCheckout } from "../src/management/review-checkout.js";
import { CodexCliManagementBackend } from "../src/management/codex-cli.js";
import {
  cleanupLocalWorktree,
  collectLocalArtifact,
  createLocalWorktree,
} from "../src/runtime/local-worktree.js";
import { createValidationEvidence } from "../src/validation/evidence.js";
import type { WorkerPacket } from "../src/protocol/worker-packet.js";
import type { ReviewResult } from "../src/management/backend.js";
import { validateArtifactClean, discardValidationResult } from "../src/validation/clean-run.js";
import { pnpmBootstrapLock } from "./helpers/pnpm-bootstrap.js";
import { selectedManagedRuntimeRequirements } from "./helpers/managed-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const repository = await mkdtemp(join(tmpdir(), "factory-review-checkout-test-"));
  roots.push(repository);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(repository, "clamp.js"), "export const clamp = 'original';\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const baseSha = git("rev-parse", "HEAD");
  const worker = await createLocalWorktree(repository, baseSha);
  let artifact;
  try {
    await writeFile(
      join(worker.path, "slugify.js"),
      "export const slugify = text => text.toLowerCase();\n",
    );
    artifact = await collectLocalArtifact(worker, "", ["slugify.js"]);
  } finally {
    await cleanupLocalWorktree(worker);
  }
  const packet: WorkerPacket = {
    baseSha,
    goal: "Add slugify",
    acceptanceCriteria: ["named slugify export lowercases text"],
    allowedPaths: ["slugify.js"],
    preconditions: [],
    outOfScope: [],
    conventions: [],
    validationCommands: ["node --test"],
    artifactContract: "clockgrove.factory/artifact-v1",
    requirements: {
      os: ["linux"],
      architecture: [],
      tools: ["node"],
      services: [],
      networkDestinations: [],
      permittedSecretNames: [],
      trust: "trusted_local",
    },
  };
  // Exact completed validation fixture: the materializer must consume this
  // immutable proof, never rerun its command or invent another completion.
  const evidence = createValidationEvidence({
    protocol: "clockgrove.factory/validation-v1",
    artifactDigest: artifact.digest,
    baseSha,
    outputTreeSha: artifact.fileManifest!.resultTreeSha,
    commands: [{ command: "node --test", exitCode: 0, durationMs: 12 }],
    passed: true,
    startedAt: "2026-09-07T07:05:00.000Z",
    completedAt: "2026-09-07T07:05:01.000Z",
  });
  await writeFile(join(repository, "clamp.js"), "controller-only dirty clamp\n");
  await writeFile(join(repository, "untracked-controller.txt"), "never review this\n");
  return {
    repository,
    packet,
    artifact,
    evidence,
    objectiveNumber: 110,
    workItemNumber: 113,
    requiresIsolation: false,
  };
}

async function greenfieldFixture(unsafeLifecycle = false) {
  const repository = await mkdtemp(join(tmpdir(), "factory-review-greenfield-test-"));
  roots.push(repository);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(repository, "README.md"), "Greenfield fixture\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const baseSha = git("rev-parse", "HEAD");
  const worker = await createLocalWorktree(repository, baseSha);
  await mkdir(join(worker.path, "packages", "example"), { recursive: true });
  await writeFile(
    join(worker.path, "package.json"),
    JSON.stringify({
      name: "greenfield",
      private: true,
      packageManager: "pnpm@10.34.5",
      scripts: {
        check: "turbo run check",
        ...(unsafeLifecycle ? { precheck: "node --test escape.test.js" } : {}),
      },
      devDependencies: { turbo: "2.5.6", typescript: "5.9.2" },
    }),
  );
  await writeFile(
    join(worker.path, "pnpm-lock.yaml"),
    pnpmBootstrapLock([".", "packages/example"], ["turbo@2.5.6", "typescript@5.9.2"]),
  );
  await writeFile(join(worker.path, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(
    join(worker.path, "turbo.json"),
    '{"tasks":{"check":{"dependsOn":["^check"]}}}\n',
  );
  await writeFile(
    join(worker.path, "packages", "example", "package.json"),
    JSON.stringify({ name: "example", scripts: { check: "tsc --noEmit" } }),
  );
  git("-C", worker.path, "add", ".");
  const artifact = await collectLocalArtifact(worker);
  await cleanupLocalWorktree(worker);
  const packet: WorkerPacket = {
    baseSha,
    goal: "Bootstrap the workspace",
    acceptanceCriteria: ["the workspace check is deterministic"],
    allowedPaths: [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "turbo.json",
      "packages/",
    ],
    preconditions: [],
    outOfScope: [],
    conventions: [],
    validationCommands: ["pnpm check"],
    managedRuntimes: selectedManagedRuntimeRequirements(["pnpm check"]),
    artifactContract: "clockgrove.factory/artifact-v1",
    requirements: {
      os: ["linux"],
      architecture: [],
      tools: ["node", "pnpm"],
      services: [],
      networkDestinations: ["registry.npmjs.org"],
      permittedSecretNames: [],
      trust: "trusted_local",
    },
  };
  const evidence = createValidationEvidence({
    protocol: "clockgrove.factory/validation-v1",
    artifactDigest: artifact.digest,
    baseSha,
    outputTreeSha: artifact.fileManifest!.resultTreeSha,
    commands: [
      { command: "pnpm --version", exitCode: 0, durationMs: 1 },
      {
        command:
          "pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org/",
        exitCode: 0,
        durationMs: 1,
      },
      { command: "pnpm check", exitCode: 0, durationMs: 1 },
    ],
    passed: true,
    startedAt: "2026-09-09T18:00:00.000Z",
    completedAt: "2026-09-09T18:00:01.000Z",
  });
  return {
    repository,
    packet,
    artifact,
    evidence,
    objectiveNumber: 166,
    workItemNumber: 168,
    requiresIsolation: false,
  };
}

describe("exact semantic review materialization", () => {
  it("rechecks the exact bounded bootstrap recipe without rerunning it", async () => {
    const input = await greenfieldFixture();
    await expect(
      withVerifiedReviewCheckout(input, async (repository) => ({
        root: JSON.parse(await readFile(join(repository, "package.json"), "utf8")).scripts.check,
        leaf: JSON.parse(
          await readFile(join(repository, "packages", "example", "package.json"), "utf8"),
        ).scripts.check,
      })),
    ).resolves.toEqual({ root: "turbo run check", leaf: "tsc --noEmit" });
  });

  it("refuses a forged passing receipt when the materialized bootstrap recipe has hooks", async () => {
    const input = await greenfieldFixture(true);
    await expect(withVerifiedReviewCheckout(input, async () => "reviewed")).rejects.toThrow(
      /lifecycle hooks/,
    );
  });

  it("binds the actual review command cwd and -C to a real independently validated tree", async () => {
    const input = await fixture();
    const validation = await validateArtifactClean(input);
    input.evidence = validation.evidence;
    await discardValidationResult(validation);
    const command = join(input.repository, "fixture-review-command.cjs");
    // Disposable protocol stand-in, not a model or semantic qualification. This
    // exercises the real argv/environment/process path after actual validation.
    await writeFile(
      command,
      `#!${process.execPath}
const assert = require('node:assert/strict');
const {readFileSync, existsSync} = require('node:fs');
const {execFileSync} = require('node:child_process');
const args = process.argv.slice(2);
const context = JSON.parse(args.at(-1).split('\\n\\n').at(-1));
assert.equal(args[args.indexOf('-C') + 1], process.cwd());
assert.equal(process.env.GIT_WORK_TREE, undefined);
assert.equal(process.env.GIT_INDEX_FILE, undefined);
assert.match(readFileSync('slugify.js', 'utf8'), /export const slugify/);
assert.match(readFileSync('clamp.js', 'utf8'), /original/);
assert.equal(existsSync('untracked-controller.txt'), false);
assert.equal(execFileSync('git', ['write-tree'], {encoding:'utf8'}).trim(), context.evidence.outputTreeSha);
console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:JSON.stringify({accepted:true, summary:process.cwd(), unmetCriteria:[], risks:[]})}}));
console.log(JSON.stringify({type:'turn.completed', usage:{input_tokens:4, output_tokens:2}}));
`,
      { mode: 0o700 },
    );
    vi.stubEnv("GIT_WORK_TREE", input.repository);
    vi.stubEnv("GIT_INDEX_FILE", join(input.repository, ".git", "index"));
    const backend = new CodexCliManagementBackend({
      command,
      authFile: join(input.repository, "no-fixture-auth.json"),
      createCodexHome: () => mkdtemp(join(input.repository, "fixture-management-home-")),
    });
    const checkpoint = vi.fn(async () => {});
    const result = await backend.review(input, checkpoint);
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 2 });
    expect(checkpoint).toHaveBeenCalledExactlyOnceWith(result);
    expect(result.review.summary).not.toBe(input.repository);
    await expect(stat(result.review.summary)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("gives the real management adapter candidate files rather than the dirty controller checkout", async () => {
    const input = await fixture();
    const deterministicCriterion = "slugify returns the exact normalized output";
    const semanticCriterion = "slugify errors are clear to first-time users";
    input.packet.acceptanceCriteria = [deterministicCriterion, semanticCriterion];
    input.packet.validation = [
      {
        tier: "mechanical",
        criteria: [deterministicCriterion],
        rationale: "Exact output is machine-verifiable.",
        evidenceCommands: ["node --test"],
      },
      {
        tier: "semantic",
        criteria: [semanticCriterion],
        rationale: "Clarity requires judgment.",
        evidenceCommands: [],
      },
    ];
    const original = JSON.stringify(input);
    let path = "";
    const runStructured = vi.fn(async (cwd: string, _schema: unknown, prompt: string) => {
      path = cwd;
      expect(prompt).toContain("This is a pre-publication artifact review");
      expect(prompt).toContain("Evaluate only packet.acceptanceCriteria");
      expect(prompt).toContain("criterion-specific semantic/visual subset");
      expect(prompt).toContain("must not be reviewed again");
      expect(prompt).toContain(semanticCriterion);
      expect(prompt).not.toContain(deterministicCriterion);
      expect(prompt).toContain("reject it as a malformed phase criterion");
      expect(prompt).toContain(
        "Ignore such lifecycle or graph-order prose outside acceptanceCriteria",
      );
      expect(cwd).not.toBe(input.repository);
      expect(await readFile(join(cwd, "slugify.js"), "utf8")).toContain("export const slugify");
      expect(await readFile(join(cwd, "clamp.js"), "utf8")).toContain("original");
      await expect(stat(join(cwd, "untracked-controller.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(execFileSync("git", ["write-tree"], { cwd, encoding: "utf8" }).trim()).toBe(
        input.evidence.outputTreeSha,
      );
      return {
        value: {
          accepted: true,
          summary: "exact candidate inspected",
          unmetCriteria: [],
          risks: [],
        },
        usage: { inputTokens: 4, outputTokens: 2 },
      };
    });
    const backend = new CodexCliManagementBackend({ runStructured });
    const checkpoint = vi.fn(async () => {});
    await backend.review(input, checkpoint);
    expect(runStructured).toHaveBeenCalledTimes(1);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(input)).toBe(original);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(input.repository, "clamp.js"), "utf8")).toBe(
      "controller-only dirty clamp\n",
    );
    await expect(stat(join(input.repository, "slugify.js"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["isolation", "tree"])(
    "the real Codex adapter refuses %s before the supplied dispatch admission",
    async (kind) => {
      const input = await fixture();
      if (kind === "isolation") input.requiresIsolation = true;
      else {
        const { digest: _digest, ...evidence } = input.evidence;
        void _digest;
        input.evidence = createValidationEvidence({ ...evidence, outputTreeSha: "a".repeat(40) });
      }
      const runStructured = vi.fn();
      const dispatch = vi.fn(async (invoke: () => Promise<ReviewResult>) => invoke());
      const backend = new CodexCliManagementBackend({ runStructured });
      await expect(backend.reviewWithAdmission(input, vi.fn(), dispatch)).rejects.toThrow();
      expect(dispatch).not.toHaveBeenCalled();
      expect(runStructured).not.toHaveBeenCalled();
    },
  );

  it.each(["tree", "artifact", "base", "failed", "isolation", "packet-isolation"])(
    "refuses %s mismatch before review dispatch",
    async (kind) => {
      const input = await fixture();
      const { digest: _digest, ...evidence } = input.evidence;
      void _digest;
      if (kind === "tree") evidence.outputTreeSha = "a".repeat(40);
      if (kind === "artifact") evidence.artifactDigest = "b".repeat(64);
      if (kind === "base") evidence.baseSha = "c".repeat(40);
      if (kind === "failed") evidence.passed = false;
      if (kind === "isolation") input.requiresIsolation = true;
      if (kind === "packet-isolation") input.packet.requirements.trust = "isolated";
      input.evidence = createValidationEvidence(evidence);
      const review = vi.fn(async () => {});
      await expect(withVerifiedReviewCheckout(input, review)).rejects.toThrow();
      expect(review).not.toHaveBeenCalled();
    },
  );

  it("does not let inherited Git redirection touch an outside index or checkout", async () => {
    const input = await fixture();
    const beforeIndex = await readFile(join(input.repository, ".git", "index"));
    vi.stubEnv("GIT_DIR", join(input.repository, ".git"));
    vi.stubEnv("GIT_WORK_TREE", input.repository);
    vi.stubEnv("GIT_INDEX_FILE", join(input.repository, ".git", "index"));
    vi.stubEnv("GIT_OBJECT_DIRECTORY", join(input.repository, ".git", "objects"));
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.worktree");
    vi.stubEnv("GIT_CONFIG_VALUE_0", input.repository);
    const review = vi.fn(async (repository: string) => {
      expect(repository).not.toBe(input.repository);
      expect(await readFile(join(repository, "slugify.js"), "utf8")).toContain(
        "export const slugify",
      );
    });
    await withVerifiedReviewCheckout(input, review);
    expect(review).toHaveBeenCalledTimes(1);
    expect(await readFile(join(input.repository, ".git", "index"))).toEqual(beforeIndex);
    expect(await readFile(join(input.repository, "clamp.js"), "utf8")).toBe(
      "controller-only dirty clamp\n",
    );
    await expect(stat(join(input.repository, "slugify.js"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses unavailable original objects rather than falling back to controller files", async () => {
    const input = await fixture();
    await rm(join(input.repository, ".git"), { recursive: true });
    const review = vi.fn(async () => {});
    await expect(withVerifiedReviewCheckout(input, review)).rejects.toThrow();
    expect(review).not.toHaveBeenCalled();
  });

  it("cleans its exact private materialization when the review fails", async () => {
    const input = await fixture();
    let path = "";
    const failure = Error("review unavailable");
    await expect(
      withVerifiedReviewCheckout(input, async (repository) => {
        path = repository;
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
