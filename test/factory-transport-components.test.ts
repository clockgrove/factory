/** Frozen component workload. This is deliberately NOT an ordinary Supervisor
 * lifecycle benchmark: those tests currently substitute reader/store methods. */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { LeaseManager } from "../src/control/lease.js";
import { LifecycleRecorder } from "../src/control/events.js";
import { decodeEventComments } from "../src/control/receipts.js";
import { observeGitHubTransportPhase } from "../src/control/mutation-observation.js";
import { SharedCapacityCoordinator } from "../src/controller/shared-capacity.js";
import { capacityReservationKey } from "../src/scheduling/capacity-ledger.js";
import type { CapacityReservation } from "../src/scheduling/capacity-ledger.js";

const BASE = "a".repeat(40);
const DIGEST = "b".repeat(64);
const DATE = "Sun, 13 Sep 2026 00:00:00 GMT";
const limits = {
  maxParallel: 2,
  maxLocalParallel: 2,
  maxCloudParallel: 0,
  backendMaxParallel: {},
  cpuCapacity: 2,
  memoryCapacityMb: 2048,
  maxPaidUnits: 0,
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

class Server {
  refs = new Map<string, string>();
  commits = new Map<
    string,
    { sha: string; tree: { sha: string }; parents: { sha: string }[]; message: string }
  >([[BASE, { sha: BASE, tree: { sha: BASE }, parents: [], message: "fixture base" }]]);
  comments: string[] = [];
  next = 1;
  phase = "bootstrap";
  rows = new Map<
    string,
    {
      phase: string;
      route: string;
      reads: number;
      writes: number;
      requestBytes: number;
      responseBytes: number;
    }
  >();
  fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.github.com") throw new Error("real network forbidden");
    const path = decodeURIComponent(url.pathname).replace("/repos/fixture/project", "");
    const body = request.method === "POST" ? await request.text() : "";
    const data = body ? JSON.parse(body) : {};
    const mutation =
      request.method !== "GET" && (path !== "/graphql" || /^\s*mutation/.test(data.query));
    let result: unknown;
    let status = 200;
    let route: string;
    if (path === "/graphql") {
      route = data.query.includes("FactoryUpdateRefs") ? "capacity-cas" : "repository-id";
      if (route === "repository-id") result = { data: { repository: { id: "R_fixture" } } };
      else {
        const args = data.variables;
        if (this.refs.get(args.name) !== args.beforeOid)
          result = { errors: [{ message: "CAS conflict" }] };
        else {
          this.refs.set(args.name, args.afterOid);
          result = { data: { updateRefs: { clientMutationId: null } } };
        }
      }
    } else if (path.startsWith("/git/ref/")) {
      const ref = `refs/${path.slice("/git/ref/".length)}`;
      route = ref.includes("coordination/capacity") ? "capacity-ref" : "lease-ref";
      const oid = this.refs.get(ref);
      result = oid ? { object: { sha: oid } } : { message: "Not Found" };
      if (!oid) status = 404;
    } else if (path === "/git/refs") {
      route = "create-ref";
      if (this.refs.has(data.ref)) {
        status = 422;
        result = { message: "already exists" };
      } else {
        this.refs.set(data.ref, data.sha);
        result = { ref: data.ref, object: { sha: data.sha } };
      }
    } else if (path.startsWith("/git/commits/")) {
      route = "commit-content";
      result = this.commits.get(path.slice("/git/commits/".length));
      if (!result) throw new Error("missing fixture commit");
    } else if (path === "/git/commits") {
      route = "create-commit";
      const sha = (this.next++).toString(16).padStart(40, "0");
      result = {
        sha,
        tree: { sha: data.tree },
        parents: data.parents.map((sha: string) => ({ sha })),
        message: data.message,
      };
      this.commits.set(sha, result as NonNullable<ReturnType<typeof this.commits.get>>);
    } else if (/^\/issues\/\d+\/comments$/.test(path) && mutation) {
      route = "budget-comment";
      this.comments.push(data.body);
      result = { id: this.comments.length };
    } else if (path === "") {
      route = "provider-time";
      result = { id: 1 };
    } else throw new Error(`unimplemented fake route ${request.method} ${path}`);
    const response = JSON.stringify(result);
    const key = `${this.phase}/${route}`;
    const row = this.rows.get(key) ?? {
      phase: this.phase,
      route,
      reads: 0,
      writes: 0,
      requestBytes: 0,
      responseBytes: 0,
    };
    if (mutation) row.writes++;
    else row.reads++;
    row.requestBytes += Buffer.byteLength(body);
    row.responseBytes += Buffer.byteLength(response);
    this.rows.set(key, row);
    return new Response(response, {
      status,
      headers: {
        date: DATE,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(response)),
      },
    });
  };
  resetRows() {
    this.rows.clear();
  }
}

function components(server: Server, token: string) {
  const store = new GitHubControlStore({
    token,
    owner: "fixture",
    repo: "project",
    requestFetch: server.fetch,
    mutationScheduler: { acquire: async () => ({ waitedMs: 0, release() {} }) },
  });
  const leases = new LeaseManager({ store });
  const capacity = new SharedCapacityCoordinator({
    store,
    repository: "fixture/project",
    baseCommitSha: BASE,
    limits,
    assertLegacyCompatible: async () => {},
  });
  return { store, leases, capacity, recorder: new LifecycleRecorder(store, leases) };
}

it("freezes real-transport lease/capacity/recorder component costs at 3/30/100 items", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(DATE));
  let finished = false;
  const workload = (async () => {
    const reports = [];
    for (const size of [3, 30, 100]) {
      const server = new Server();
      let c = components(server, `component-${size}`);
      const rowsFor = () =>
        [...server.rows.values()].sort((a, b) =>
          `${a.phase}/${a.route}`.localeCompare(`${b.phase}/${b.route}`),
        );
      const lease = await c.leases.acquire(
        { objective: 7, runId: "frozen-run", holder: "fixture", policyDigest: DIGEST },
        await c.store.readCommit(BASE),
      );
      await c.capacity.initialize();
      const bootstrap = rowsFor();
      const owner = {
        objective: 7,
        runId: "frozen-run",
        directorEpoch: lease.epoch,
        policyDigest: DIGEST,
      };
      for (const mode of ["cold", "warm", "restart"] as const) {
        if (mode === "restart") c = components(server, `restart-component-${size}`);
        server.resetRows();
        let observedCounts = { reads: 0, writes: 0, unclassified: 0 };
        const generations: number[] = [];
        await observeGitHubTransportPhase(
          "component-workload",
          (row) => {
            observedCounts = {
              reads: row.readRequests,
              writes: row.mutationRequests,
              unclassified: row.unclassifiedRequests,
            };
          },
          async () => {
            for (let index = 0; index < size; index++) {
              const workItem = index + 100;
              // Identity changes across repeated workloads; each mode creates genuine new history.
              const attempt = mode === "cold" ? 1 : mode === "warm" ? 2 : 3;
              server.phase = "current-owner";
              await c.leases.assertCurrent(lease);
              await c.leases.assertCurrent(lease);
              const input = {
                objective: 7,
                workItem,
                attempt,
                phase: "execution" as const,
                backendId: "fixture/local",
                admissionClass: "local" as const,
                local: true,
                cpu: 1,
                memoryMb: 128,
                paidUnits: 0,
                paths: [],
                exclusiveResources: [],
              };
              const reservation: CapacityReservation = {
                ...input,
                key: capacityReservationKey(input),
              };
              server.phase = "admission-observation";
              await c.capacity.snapshot();
              server.phase = "capacity-reserve";
              const result = await c.capacity.reserve(owner, reservation, limits);
              expect(result.reserved).toBe(true);
              server.phase = "acknowledgment-generation";
              // Same logical consumer across baseline/candidate, with supported result reuse.
              generations.push(
                "generation" in result
                  ? Number(result.generation)
                  : (await c.capacity.snapshot()).generation,
              );
              server.phase = "accounting";
              const durable = {
                ref: "refs/fixture",
                oid: BASE,
                objective: 7,
                workItem,
                attempt,
                backend: "fixture/local",
                baseSha: BASE,
                runId: "frozen-run",
                directorEpoch: lease.epoch,
                policyDigest: DIGEST,
                sequence: 1,
                receiptDigest: DIGEST,
                createdAt: new Date(DATE),
              };
              await c.recorder.budgetBatch([
                {
                  lease,
                  reservation: durable,
                  workItemNodeId: `I_${workItem}`,
                  sequence: attempt * 1000 + index * 2,
                  event: "BudgetReconciled",
                  unit: "local_milliseconds",
                  amount: 10,
                  usageId: `worker-${workItem}-${attempt}`,
                },
                {
                  lease,
                  reservation: durable,
                  workItemNodeId: `I_${workItem}`,
                  sequence: attempt * 1000 + index * 2 + 1,
                  event: "BudgetReconciled",
                  unit: "validation_milliseconds",
                  amount: 5,
                  usageId: `validation-${workItem}-${attempt}`,
                },
              ]);
              server.phase = "capacity-release";
              await c.capacity.release(owner, reservation.key);
            }
          },
        );
        const rows = rowsFor();
        const reads = rows.reduce((sum, row) => sum + row.reads, 0);
        const writes = rows.reduce((sum, row) => sum + row.writes, 0);
        expect(observedCounts).toEqual({ reads, writes, unclassified: 0 });
        expect(generations.every((value, i) => i === 0 || value > generations[i - 1]!)).toBe(true);
        reports.push({
          size,
          mode,
          reads,
          writes,
          total: reads + writes,
          rows,
          bootstrap: mode === "cold" ? bootstrap : [],
          effectsDigest: hash({
            refs: [...server.refs],
            comments: server.comments.map(decodeEventComments),
          }),
          gitTransfers: 0,
          nominalTransportCostUnits: reads + writes,
          limitations:
            "Component workload only; no Supervisor, compilation, artifact, PR, readiness, topology scheduling, or model execution. Mutation scheduler is immediate; Octokit timers are simulated. Modes grow one history, not equal checkpoints. Warm mode includes new history; bootstrap reported separately. Cost units are request counts, not measured latency.",
        });
      }
    }
    if (process.env.FACTORY_COMPONENT_OUTPUT)
      await writeFile(
        process.env.FACTORY_COMPONENT_OUTPUT,
        `${JSON.stringify(reports, null, 2)}\n`,
      );
  })().finally(() => {
    finished = true;
  });
  void workload.catch(() => {});
  try {
    while (!finished) await vi.advanceTimersByTimeAsync(1_000);
    await workload;
  } finally {
    vi.useRealTimers();
  }
}, 120_000);
