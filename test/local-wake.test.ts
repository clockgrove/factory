import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it, vi } from "vitest";
import { publishLocalWake, subscribeLocalWake } from "../src/control/local-wake.js";

it("routes cross-process publication to every matching subscriber and cleans endpoints on retirement", async () => {
  const repository = `fixture/${randomUUID()}`;
  const root = await mkdtemp(join(tmpdir(), "factory-wake-test-"));
  const callbacks = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
  const scopes = [
    { repository },
    { repository: repository.toUpperCase() },
    { repository, objective: 7 },
    { repository: `${repository}-other` },
  ];
  const disposers: Array<() => Promise<void>> = [];
  try {
    for (let i = 0; i < scopes.length; i++)
      disposers.push(await subscribeLocalWake(scopes[i]!, callbacks[i]!));
    const module = join(root, "wake.mjs");
    await build({
      entryPoints: [resolve("src/control/local-wake.ts")],
      outfile: module,
      platform: "node",
      format: "esm",
      bundle: true,
    });
    const endpointRoot = `/tmp/clockgrove-factory-wake-${process.getuid!()}`;
    const prefix = createHash("sha256")
      .update(JSON.stringify([repository.toLowerCase(), "discovery"]))
      .digest("hex")
      .slice(0, 32);
    await promisify(execFile)(process.execPath, [
      "--input-type=module",
      "-e",
      `import {subscribeLocalWake} from ${JSON.stringify(pathToFileURL(module).href)}; await subscribeLocalWake(${JSON.stringify(scopes[0])}, () => {}); process.exit(0);`,
    ]);
    expect((await readdir(endpointRoot)).filter((name) => name.startsWith(prefix))).toHaveLength(3);
    const script = `import {publishLocalWake} from ${JSON.stringify(pathToFileURL(module).href)}; await publishLocalWake(${JSON.stringify(scopes[0])}, "first");`;
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script]);
    await vi.waitFor(() => expect(callbacks[0]).toHaveBeenCalledTimes(1));
    expect(callbacks[1]).toHaveBeenCalledTimes(1);
    expect((await readdir(endpointRoot)).filter((name) => name.startsWith(prefix))).toHaveLength(2);
    expect(callbacks[2]).not.toHaveBeenCalled();
    expect(callbacks[3]).not.toHaveBeenCalled();
    const observation = callbacks[0]!.mock.calls[0]![0];
    expect(observation.receivedAt - observation.publishedAt).toBeLessThan(5_000);
    await publishLocalWake(scopes[0]!, "first");
    expect(callbacks[0]).toHaveBeenCalledTimes(2); // successful replay repair remains wakeable
    await promisify(execFile)(process.execPath, [
      "--input-type=module",
      "-e",
      `import {publishLocalWake} from ${JSON.stringify(pathToFileURL(module).href)}; await publishLocalWake(${JSON.stringify(scopes[2])}, "resume");`,
    ]);
    await vi.waitFor(() => expect(callbacks[2]).toHaveBeenCalledTimes(1));
    for (const dispose of disposers.splice(0)) await dispose();
    await publishLocalWake(scopes[0]!, "after-retirement");
    expect(callbacks[0]).toHaveBeenCalledTimes(2);
    // A restarted receiver has no durable dedup state and accepts the persisted replay hint.
    disposers.push(await subscribeLocalWake(scopes[0]!, callbacks[0]!));
    await publishLocalWake(scopes[0]!, "first");
    await vi.waitFor(() => expect(callbacks[0]).toHaveBeenCalledTimes(3));
  } finally {
    for (const dispose of disposers) await dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("does not create a receiver or fail publication when no local consumer exists", async () => {
  const repository = `fixture/${randomUUID()}`;
  const root = `/tmp/clockgrove-factory-wake-${process.getuid!()}`;
  const prefix = createHash("sha256")
    .update(JSON.stringify([repository.toLowerCase(), "discovery"]))
    .digest("hex")
    .slice(0, 32);
  const matchingEndpoints = async () =>
    (await readdir(root).catch(() => [])).filter((name) => name.startsWith(`${prefix}-`));
  expect(await matchingEndpoints()).toEqual([]);
  await expect(publishLocalWake({ repository }, "request")).resolves.toBeUndefined();
  expect(await matchingEndpoints()).toEqual([]);
});

it("wakes the real controller after successful application publication, then discovers authority", async () => {
  const { GitHubRepositoryController } = await import("../src/controller/repository-controller.js");
  const { FactoryApplicationService } = await import("../src/application/services.js");
  const { decodeEventComments } = await import("../src/control/receipts.js");
  const repository = `fixture/${randomUUID()}`;
  const [owner, repo] = repository.split("/");
  const snapshot: import("../src/application/services.js").ApplicationSnapshot = {
    id: "objective",
    number: 7,
    title: "Fixture",
    defaultBranch: "main",
    workItems: [],
    factoryEvents: [],
  };
  let repaired = false;
  const service = new FactoryApplicationService({
    owner: owner!,
    repo: repo!,
    reader: { readObjective: async () => structuredClone(snapshot) },
    store: {
      serverTime: async () => new Date(),
      getAuthenticatedLogin: async () => "operator",
      ensureObjectiveLabel: async () => {},
      ensureDiscoveryLocator: async () => {
        repaired = true;
      },
      addIssueComment: async (_id, body) => {
        snapshot.factoryEvents!.push(...decodeEventComments(body));
      },
    },
  });
  const stop = new AbortController();
  const observations: Array<{ event: string; at: number; publishedAt?: number }> = [];
  const dispatched = vi.fn(async () => {});
  const discover = vi.fn(async () =>
    snapshot.factoryEvents!.flatMap((event) =>
      event.event === "ActivationRequested"
        ? [
            {
              objective: 7,
              activatedAt: event.at,
              requestId: event.requestId,
              policy: event.policy,
              policyDigest: event.policyDigest,
              baseSha: event.baseSha,
              requestedBy: event.requestedBy,
            },
          ]
        : [],
    ),
  );
  const controller = new GitHubRepositoryController({
    repositoryIdentity: repository,
    signal: stop.signal,
    store: { discoverObjectiveActivations: discover },
    reconcileObjective: dispatched,
    onWakeObservation: (o) => observations.push(o),
  });
  const running = controller.run();
  try {
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
    const start = Date.now();
    await service.activate({ objective: 7, requestId: "published", baseSha: "a".repeat(40) });
    await vi.waitFor(() => expect(dispatched).toHaveBeenCalledTimes(1));
    expect(repaired).toBe(true);
    expect(Date.now() - start).toBeLessThan(5_000);
    const wake = observations.find((o) => o.event === "publication-wake")!;
    expect(wake.at - wake.publishedAt!).toBeLessThan(5_000);
    expect(observations.some((o) => o.event === "scan-start" && o.at >= wake.at)).toBe(true);
  } finally {
    stop.abort();
    await running;
  }
});
