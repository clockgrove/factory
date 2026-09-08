import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { decodeEventComments } from "../src/control/receipts.js";
import { PlatformUnavailableError } from "../src/platform.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

it("reconstructs candidate native usage after checkpoint completion but before its accounting receipt", async () => {
  const fixture = await providerSupervisorFixture("daytona-burst");
  const write = vi.mocked(GitHubControlStore.prototype.addIssueComment).getMockImplementation()!;
  let interrupted = false;
  vi.spyOn(GitHubControlStore.prototype, "addIssueComment").mockImplementation(async function (
    this: GitHubControlStore,
    issue,
    body,
  ) {
    if (
      !interrupted &&
      decodeEventComments(body).some(
        (event) =>
          event.kind === "budget" &&
          event.event === "BudgetReconciled" &&
          event.unit === "sandbox_milliseconds" &&
          event.usageId?.startsWith("integration-validation-"),
      )
    ) {
      interrupted = true;
      throw new PlatformUnavailableError(
        { kind: "rate_limit", retryAfterMs: 1 },
        new Error("bounded fixture interruption before accounting commit"),
      );
    }
    return write.call(this, issue, body);
  });
  try {
    await expect(fixture.run()).rejects.toThrow(PlatformUnavailableError);
    expect(interrupted).toBe(true);
    expect(fixture.resources.size).toBe(0);
    expect(fixture.activity.filter((entry) => entry.invocation)).toHaveLength(1);
    expect(
      fixture
        .events()
        .filter((event) =>
          ["FactoryRunCompleted", "FactoryRunEscalated", "FactoryRunCancelled"].includes(
            event.event,
          ),
        ),
    ).toHaveLength(0);
    const starts = fixture.events().filter((event) => event.event === "FactoryRunStarted");
    const reservations = fixture.events().filter((event) => event.event === "AttemptReserved");
    const checkpoint = [...fixture.refs].find(([ref]) => ref.includes("/merge-candidates/"));
    expect(checkpoint).toBeDefined();
    const durable = JSON.parse(
      execFileSync(
        "git",
        ["show", `${checkpoint![1]}:.clockgrove-factory/control/merge-candidate.json`],
        {
          cwd: fixture.repository,
          encoding: "utf8",
        },
      ),
    ) as {
      identity: { workItem: number; deliveryHeadSha: string; targetBaseSha: string };
      validation: { outputTreeSha: string };
      isolatedResource: { sandboxMilliseconds: number };
    };
    const publication = fixture
      .events()
      .find(
        (event) =>
          event.event === "PublicationRecorded" && event.workItem === durable.identity.workItem,
      );
    expect(publication?.event).toBe("PublicationRecorded");
    if (publication?.event !== "PublicationRecorded")
      throw new Error("missing original publication");
    const originalPublication = structuredClone(publication);
    expect(durable.identity.deliveryHeadSha).not.toBe(publication.headSha);
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: fixture.repository,
        encoding: "utf8",
      }).trim();
    expect(git("show", "-s", "--format=%P", durable.identity.deliveryHeadSha)).toBe(
      `${publication.headSha} ${durable.identity.targetBaseSha}`,
    );
    expect(git("rev-parse", `${durable.identity.deliveryHeadSha}^{tree}`)).toBe(
      durable.validation.outputTreeSha,
    );
    const publicationRefreshes = () =>
      vi
        .mocked(GitHubControlStore.prototype.compareAndSwapRef)
        .mock.calls.map(([update]) => update)
        .filter((update) => update.ref === `refs/heads/${publication.branch}`);
    const expectedRefresh = {
      ref: `refs/heads/${publication.branch}`,
      beforeOid: publication.headSha,
      afterOid: durable.identity.deliveryHeadSha,
    };
    expect(publicationRefreshes()).toEqual([expect.objectContaining(expectedRefresh)]);

    expect(await fixture.run()).toMatchObject({ status: "completed" });
    expect(publicationRefreshes()).toEqual([expect.objectContaining(expectedRefresh)]);
    expect(
      fixture
        .events()
        .filter(
          (event) =>
            event.event === "PublicationRecorded" && event.workItem === durable.identity.workItem,
        ),
    ).toEqual([originalPublication]);
    expect(fixture.activity.filter((entry) => entry.invocation)).toHaveLength(1);
    expect(fixture.activity.filter((entry) => entry.operation === "candidate-review")).toHaveLength(
      1,
    );
    expect(fixture.events().filter((event) => event.event === "FactoryRunStarted")).toEqual(starts);
    expect(
      fixture
        .events()
        .filter((event) => event.event === "AttemptReserved")
        .slice(0, reservations.length),
    ).toEqual(reservations);
    const native = fixture
      .events()
      .filter(
        (event) =>
          event.kind === "budget" &&
          event.unit === "sandbox_milliseconds" &&
          event.usageId?.startsWith("integration-validation-"),
      );
    expect(native.map((event) => event.event)).toEqual(["BudgetReserved", "BudgetReconciled"]);
    expect(native[1]).toMatchObject({ amount: durable.isolatedResource.sandboxMilliseconds });
    expect(fixture.resources.size).toBe(0);
  } finally {
    await fixture.dispose();
  }
}, 30_000);
