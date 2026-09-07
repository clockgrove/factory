import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";
import { CodexCliManagementBackend } from "../src/management/codex-cli.js";
import type { ReviewContext } from "../src/management/backend.js";
import * as reviewCheckout from "../src/management/review-checkout.js";

type Fixture = Awaited<ReturnType<typeof providerSupervisorFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  vi.restoreAllMocks();
});

it("every fresh ordinary Supervisor review inspects the exact candidate rather than the controller", async () => {
  const f = await providerSupervisorFixture("daytona-burst", {
    localOnly: true,
    dependencyChain: true,
  });
  fixtures.push(f);
  const paths: string[] = [];
  const backend = new CodexCliManagementBackend({
    runStructured: async (cwd, _schema, prompt) => {
      const context = JSON.parse(prompt.split("\n\n").at(-1)!) as ReviewContext;
      expect(cwd).not.toBe(f.repository);
      paths.push(cwd);
      for (const path of context.artifact.changedPaths)
        expect((await readFile(join(cwd, path))).length).toBeGreaterThan(0);
      expect(execFileSync("git", ["write-tree"], { cwd, encoding: "utf8" }).trim()).toBe(
        context.evidence.outputTreeSha,
      );
      return {
        value: {
          accepted: true,
          summary: "Fixture observed exact review files",
          unmetCriteria: [],
          risks: [],
        },
        usage: { inputTokens: 4, outputTokens: 2 },
      };
    },
  });
  f.management.review = backend.review.bind(backend);
  f.management.reviewWithAdmission = backend.reviewWithAdmission.bind(backend);
  await expect(f.run()).resolves.toMatchObject({ status: "completed" });
  expect(paths.length).toBeGreaterThanOrEqual(3);
  for (const path of paths) await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

it("generic isolated/native management adapters retain their artifact contract without local review preparation", async () => {
  const f = await providerSupervisorFixture("daytona-burst", { nativeStack: true });
  fixtures.push(f);
  const prepare = vi.spyOn(reviewCheckout, "withVerifiedReviewCheckout");
  const original = f.management.review;
  const contexts: ReviewContext[] = [];
  vi.spyOn(f.management, "review").mockImplementation(async (context, checkpoint) => {
    contexts.push(context);
    expect(context.repository).toBe(f.repository);
    expect(context.artifact.digest).toBe(context.evidence.artifactDigest);
    expect(context.packet.baseSha).toBe(context.evidence.baseSha);
    return original(context, checkpoint);
  });
  await expect(f.run()).resolves.toMatchObject({ status: "completed" });
  expect(contexts.some((context) => context.requiresIsolation === true)).toBe(true);
  expect(contexts.some((context) => context.packet.requirements.trust === "isolated")).toBe(true);
  expect(prepare).not.toHaveBeenCalled();
}, 30_000);
