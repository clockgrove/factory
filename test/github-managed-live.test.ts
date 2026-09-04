import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  GITHUB_MANAGED_AGENT_PROFILES,
  GitHubManagedAgentBackend,
  resolveManagedAgentActor,
} from "../src/backends/github-copilot.js";
import { DaytonaBackend } from "../src/backends/daytona.js";
import { GitHubControlStore } from "../src/control/github-store.js";
import { Dispatcher, GithubOctokitWriter } from "../src/dispatch.js";
import type { AttemptContext, BackendHandle } from "../src/execution/backend.js";
import { assertArtifactScope, verifyArtifact } from "../src/execution/artifacts.js";
import { GraphApplier, GithubOctokitGraphWriter, type CompiledObjective } from "../src/graph.js";
import { GitHubReader } from "../src/github.js";
import {
  CircuitBreaker,
  ConcurrencyLimiter,
  ContentCreationPacer,
  MutationScheduler,
} from "../src/platform.js";
import { verifyLocalRepository } from "../src/supervisor.js";

const LIVE = process.env.FACTORY_LIVE_GITHUB_MANAGED === "1";
const MAX_MINUTES = Number(process.env.FACTORY_LIVE_GITHUB_MANAGED_MAX_MINUTES ?? "10");

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the live managed-agent gate`);
  return value;
}

function repository(): { owner: string; repo: string } {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(required("FACTORY_LIVE_GITHUB_MANAGED_REPOSITORY"));
  if (!match) {
    throw new Error(
      "FACTORY_LIVE_GITHUB_MANAGED_REPOSITORY must name an explicitly disposable OWNER/REPO",
    );
  }
  return { owner: match[1]!, repo: match[2]! };
}

function acknowledgePaidMutation(): void {
  if (
    process.env.FACTORY_LIVE_GITHUB_MANAGED_MUTATION_ACK !==
    "create-close-disposable-objective-and-pr"
  ) {
    throw new Error(
      "FACTORY_LIVE_GITHUB_MANAGED_MUTATION_ACK=create-close-disposable-objective-and-pr is required",
    );
  }
  if (process.env.FACTORY_LIVE_GITHUB_MANAGED_COST_ACK !== "consume-one-paid-agent-session") {
    throw new Error(
      "FACTORY_LIVE_GITHUB_MANAGED_COST_ACK=consume-one-paid-agent-session is required",
    );
  }
  if (process.env.FACTORY_LIVE_GITHUB_MANAGED_MAX_SESSIONS !== "1") {
    throw new Error(
      "FACTORY_LIVE_GITHUB_MANAGED_MAX_SESSIONS=1 is required and is the hard gate ceiling",
    );
  }
  if (
    process.env.FACTORY_LIVE_GITHUB_MANAGED_VALIDATION_ACK !==
    "create-one-isolated-daytona-validator"
  ) {
    throw new Error(
      "FACTORY_LIVE_GITHUB_MANAGED_VALIDATION_ACK=create-one-isolated-daytona-validator is required",
    );
  }
  if (!Number.isFinite(MAX_MINUTES) || MAX_MINUTES < 1 || MAX_MINUTES > 15) {
    throw new Error("FACTORY_LIVE_GITHUB_MANAGED_MAX_MINUTES must be between 1 and 15");
  }
}

async function waitForWorkItem(reader: GitHubReader, objective: number, workItem: number) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const snapshot = await reader.readObjective(objective);
    if (snapshot.workItems.some((candidate) => candidate.number === workItem)) {
      return snapshot;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  throw new Error(`disposable Work Item #${workItem} did not become readable`);
}

async function waitForManagedTerminal(
  backend: GitHubManagedAgentBackend,
  handle: BackendHandle,
  deadline: Date,
) {
  while (Date.now() < deadline.getTime()) {
    const observation = await backend.observe(handle);
    if (observation.state === "succeeded") return;
    if (observation.state === "failed" || observation.state === "cancelled") {
      throw new Error(observation.reason ?? `managed worker ${observation.state}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
  }
  await backend.cancel(handle);
  throw new Error("managed worker exceeded its hard conformance deadline");
}

describe.skipIf(!LIVE)("live GitHub managed-agent plus isolated-validator smoke", () => {
  it(
    "collects and independently validates one disposable provider PR, then cleans every resource",
    async () => {
      acknowledgePaidMutation();
      const target = repository();
      const checkout = resolve(required("FACTORY_LIVE_GITHUB_MANAGED_CHECKOUT"));
      await verifyLocalRepository(checkout, target.owner, target.repo);
      const backendId = required("FACTORY_LIVE_GITHUB_MANAGED_BACKEND");
      const profile = GITHUB_MANAGED_AGENT_PROFILES.find(
        (candidate) => candidate.backendId === backendId,
      );
      if (!profile) {
        throw new Error(
          `FACTORY_LIVE_GITHUB_MANAGED_BACKEND must be one of ${GITHUB_MANAGED_AGENT_PROFILES.map((candidate) => candidate.backendId).join(", ")}`,
        );
      }

      const token = required("GITHUB_TOKEN");
      const breaker = new CircuitBreaker();
      const pacer = new ContentCreationPacer();
      const concurrency = new ConcurrencyLimiter();
      const mutations = new MutationScheduler({ pacer });
      const github = { token, ...target };
      const controls = {
        circuitBreaker: breaker,
        pacer,
        concurrency,
        mutationScheduler: mutations,
      };
      const store = new GitHubControlStore({ ...github, ...controls });
      const reader = new GitHubReader(github);
      const graph = new GraphApplier({
        writer: new GithubOctokitGraphWriter(github),
        ...controls,
      });
      const suffix = randomUUID().slice(0, 8);
      const file = `factory-managed-conformance-${suffix}.txt`;
      const expected = `managed-${suffix}`;
      let parent: { id: string; number: number } | undefined;
      let child: { id: string; number: number } | undefined;
      let backend: GitHubManagedAgentBackend | undefined;
      let handle: BackendHandle | undefined;
      let pullNumber: number | undefined;
      let pullHeadRef: string | undefined;
      let pullHeadRepository: string | undefined;
      let defaultBranch: string | undefined;

      try {
        const created = await store.stackRequest(
          "POST /repos/{owner}/{repo}/issues",
          {
            ...target,
            title: `Factory disposable managed-agent Objective ${suffix}`,
            body: "Disposable paid Factory conformance Objective. The gated harness will close its Work Item, pull request, and this issue without merging.",
          },
          true,
        );
        const issue = created.data as { node_id?: unknown; number?: unknown };
        if (typeof issue.node_id !== "string" || typeof issue.number !== "number") {
          throw new Error("GitHub create-issue response omitted node_id or number");
        }
        parent = { id: issue.node_id, number: issue.number };

        let snapshot = await reader.readObjective(parent.number);
        defaultBranch = snapshot.defaultBranch;
        const base = await store.getBranchHead(snapshot.defaultBranch);
        const compiled: CompiledObjective = {
          title: `Factory managed conformance ${suffix}`,
          workItems: [
            {
              id: `managed-${suffix}`,
              title: `Create disposable conformance file ${suffix}`,
              goal: `Create ${file} containing exactly one line: ${expected}`,
              acceptance: [`${file} contains exactly ${expected} followed by a newline`],
              scope: [file],
              preconditions: [`${file} does not exist on the base branch`],
              outOfScope: ["all other repository content"],
              conventions: ["preserve a trailing newline"],
              dependsOn: [],
              baseSha: base.oid,
              validationCommands: [`grep -qx ${expected} ${file}`],
              requirements: {
                os: ["linux"],
                architecture: [],
                tools: ["git", "bash", "grep"],
                services: [],
                networkDestinations: [],
                permittedSecretNames: [],
                trust: "trusted_local",
                timeoutMinutes: MAX_MINUTES,
                cpu: 1,
                memoryMb: 1_024,
                diskMb: 2_048,
              },
              artifactContract: "clockgrove.factory/artifact-v1",
            },
          ],
        };
        const createdItems = await graph.apply(compiled, {
          repositoryId: snapshot.repositoryId,
          objectiveIssueId: parent.id,
          ...(snapshot.workItemLabelId ? { workItemLabelId: snapshot.workItemLabelId } : {}),
        });
        child = createdItems.get(`managed-${suffix}`);
        if (!child) throw new Error("GraphApplier did not return the disposable Work Item");
        snapshot = await waitForWorkItem(reader, parent.number, child.number);

        const resolution = resolveManagedAgentActor(profile, snapshot.managedAgentActors ?? []);
        if (!resolution.actor) {
          throw new Error(resolution.reason ?? `${profile.displayName} was not discovered`);
        }
        const dispatcher = new Dispatcher({
          writer: new GithubOctokitWriter(github),
          repositoryId: snapshot.repositoryId,
          managedAgentActorId: resolution.actor.id,
          defaultBranch: snapshot.defaultBranch,
          // This gate never exercises escalation; a valid human node ID is not needed.
          escalateToId: "unused-live-conformance",
          ...controls,
        });
        backend = new GitHubManagedAgentBackend({
          reader,
          dispatcher,
          repository: checkout,
          profile,
          actorResolution: resolution,
        });
        await expect(backend.probe()).resolves.toMatchObject({
          available: true,
          authenticated: true,
        });

        const deadline = new Date(Date.now() + MAX_MINUTES * 60_000);
        const workItem = compiled.workItems[0]!;
        const packet = {
          goal: workItem.goal,
          acceptanceCriteria: workItem.acceptance,
          allowedPaths: workItem.scope,
          preconditions: workItem.preconditions,
          outOfScope: workItem.outOfScope,
          conventions: workItem.conventions,
          baseSha: base.oid,
          validationCommands: workItem.validationCommands!,
          requirements: workItem.requirements!,
          artifactContract: "clockgrove.factory/artifact-v1" as const,
        };
        const context: AttemptContext = {
          repository: `${target.owner}/${target.repo}`,
          objective: parent.number,
          workItem: child.number,
          attempt: 1,
          runId: `live-managed-${suffix}`,
          directorEpoch: 1,
          policyDigest: "f".repeat(64),
          workspace: checkout,
          providerBaseRef: snapshot.defaultBranch,
          deadline,
          packet,
        };
        handle = await backend.launch(context);
        await waitForManagedTerminal(backend, handle, deadline);
        pullNumber = Number(handle.metadata?.pullNumber);
        if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
          throw new Error("managed backend did not identify its disposable pull request");
        }

        const pull = await store.stackRequest("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          ...target,
          pull_number: pullNumber,
        });
        const pullData = pull.data as {
          merged?: unknown;
          head?: { ref?: unknown; repo?: { full_name?: unknown } };
        };
        expect(pullData.merged).toBe(false);
        if (typeof pullData.head?.ref === "string") pullHeadRef = pullData.head.ref;
        if (typeof pullData.head?.repo?.full_name === "string") {
          pullHeadRepository = pullData.head.repo.full_name;
        }

        const artifact = await backend.collect(handle);
        expect(artifact).toMatchObject({
          outcome: "succeeded",
          changedPaths: [file],
          baseSha: base.oid,
        });
        expect(artifact.patch).toContain(`+${expected}`);
        verifyArtifact(artifact);
        assertArtifactScope(artifact, packet.allowedPaths);
        const validator = new DaytonaBackend({ repository: checkout });
        await expect(validator.probeValidation!()).resolves.toMatchObject({
          available: true,
          authenticated: true,
        });
        const validation = await validator.validate!({
          ...context,
          artifact,
          packet: {
            ...packet,
            requirements: { ...packet.requirements, trust: "isolated" },
          },
          policyNetworkDestinations: ["registry.npmjs.org", "*.npmjs.org"],
        });
        expect(validation.passed, validation.failureReason).toBe(true);

        await backend.cleanup(handle);
        handle = undefined;
        await store.closePullRequest(pullNumber);
        if (
          pullHeadRef &&
          pullHeadRepository?.toLowerCase() === `${target.owner}/${target.repo}`.toLowerCase() &&
          pullHeadRef !== snapshot.defaultBranch
        ) {
          await store.stackRequest(
            "DELETE /repos/{owner}/{repo}/git/refs/{ref}",
            { ...target, ref: `heads/${pullHeadRef}` },
            true,
          );
          expect(await store.readRef(`refs/heads/${pullHeadRef}`)).toBeNull();
          pullHeadRef = undefined;
        }
        await store.closeIssue(child.number);
        await store.closeIssue(parent.number);
        const [closedChild, closedParent] = await Promise.all([
          store.stackRequest("GET /repos/{owner}/{repo}/issues/{issue_number}", {
            ...target,
            issue_number: child.number,
          }),
          store.stackRequest("GET /repos/{owner}/{repo}/issues/{issue_number}", {
            ...target,
            issue_number: parent.number,
          }),
        ]);
        expect(closedChild.data).toMatchObject({ state: "closed" });
        expect(closedParent.data).toMatchObject({ state: "closed" });
        child = undefined;
        parent = undefined;
        pullNumber = undefined;
      } finally {
        if (handle && backend) {
          await backend.cancel(handle).catch(() => undefined);
          await backend.cleanup(handle).catch(() => undefined);
        }
        if (pullNumber) {
          await store.closePullRequest(pullNumber).catch(() => undefined);
        }
        if (
          pullHeadRef &&
          pullHeadRepository?.toLowerCase() === `${target.owner}/${target.repo}`.toLowerCase() &&
          pullHeadRef !== defaultBranch
        ) {
          await store
            .stackRequest(
              "DELETE /repos/{owner}/{repo}/git/refs/{ref}",
              { ...target, ref: `heads/${pullHeadRef}` },
              true,
            )
            .catch(() => undefined);
        }
        if (child) await store.closeIssue(child.number).catch(() => undefined);
        if (parent) await store.closeIssue(parent.number).catch(() => undefined);
      }
    },
    16 * 60_000,
  );
});
