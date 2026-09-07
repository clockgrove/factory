import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

type Fixture = Awaited<ReturnType<typeof providerSupervisorFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

it("every fresh ordinary Supervisor review inspects the exact candidate rather than the controller", async () => {
  const f = await providerSupervisorFixture("daytona-burst", {
    localOnly: true,
    dependencyChain: true,
  });
  fixtures.push(f);
  const original = f.management.review;
  const paths: string[] = [];
  vi.spyOn(f.management, "review").mockImplementation(async (context, checkpoint) => {
    expect(context.repository).not.toBe(f.repository);
    paths.push(context.repository);
    for (const path of context.artifact.changedPaths)
      expect((await readFile(join(context.repository, path))).length).toBeGreaterThan(0);
    expect(
      execFileSync("git", ["write-tree"], { cwd: context.repository, encoding: "utf8" }).trim(),
    ).toBe(context.evidence.outputTreeSha);
    return original(context, checkpoint);
  });
  await expect(f.run()).resolves.toMatchObject({ status: "completed" });
  expect(paths.length).toBeGreaterThanOrEqual(3);
  for (const path of paths) await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);
