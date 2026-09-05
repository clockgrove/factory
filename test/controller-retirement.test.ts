import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import type { FactoryReadSnapshot } from "../src/application/status.js";
import {
  compiledGraphProjectionRef,
  compiledGraphRef,
  type CompiledGraphReadStore,
} from "../src/control/graphs.js";
import { sourceUsesCurrentProducer } from "../src/controller/retirement.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import { discoverRecoveryActivation } from "../src/recovery/discovery.js";
import { recoveryEventDigest, recoverySourceEventsDigest } from "../src/recovery/identity.js";
import {
  parseRecoveryPlan,
  recoveryHistoryDigest,
  recoveryPlanBindingDigest,
  recoveryPlanDigest,
  recoveryPlanRef,
  type RecoveryPlan,
} from "../src/recovery/plan.js";
import { recoverySuccessorRunId } from "../src/recovery/requests.js";
import type { LocalScopeHost } from "../src/runtime/local-scope.js";
import { SystemdUserService } from "../src/service/systemd-user-service.js";

const sha = (value: string) => value.repeat(40);
const digest = (value: string) => value.repeat(64);
const at = "2026-09-04T00:00:00Z";
const repository = "factory-retirement/disposable";
function event(sequence: number, fields: Record<string, unknown>): FactoryEvent {
  return parseFactoryEvent({
    protocol: "clockgrove.factory/v2",
    objective: 1,
    runId: "source",
    at,
    sequence,
    ...fields,
  });
}

function fixture() {
  const policy = DEFAULT_RUN_POLICY;
  const host: LocalScopeHost = {
    hostIdentity: digest("c"),
    producerPid: 123,
    producerStartTicks: "456",
    producerUnit: "factory-fixture.service",
    producerInvocationId: "d".repeat(32),
  };
  const start = event(1, {
    kind: "run",
    event: "FactoryRunStarted",
    actor: "operator",
    repository,
    objectiveAuthor: "operator",
    fork: false,
    baseBranch: "main",
    baseSha: sha("a"),
    policy,
    policyDigest: policyDigest(policy),
  });
  const reserved = event(2, {
    kind: "attempt",
    event: "AttemptReserved",
    workItem: 2,
    attempt: 1,
    backend: "codex-cli",
    baseSha: sha("a"),
    directorEpoch: 1,
    policyDigest: policyDigest(policy),
    localScopeBatch: {
      identity: {
        protocol: "clockgrove.factory/local-scope-v1",
        repository,
        objective: 1,
        workItem: 2,
        attempt: 1,
        runId: "source",
        directorEpoch: 1,
        policyDigest: policyDigest(policy),
        phase: "execution",
        commandIndex: 0,
        invocationDigest: digest("b"),
        hostIdentity: host.hostIdentity,
        producerUnit: host.producerUnit,
        producerInvocationId: host.producerInvocationId,
      },
      commandCount: 1,
      producerPid: host.producerPid,
      producerStartTicks: host.producerStartTicks,
      deadline: "2026-09-05T00:00:00Z",
    },
  });
  const terminal = event(3, { kind: "run", event: "FactoryRunEscalated" });
  // Accounting arriving after the terminal is part of the approved immutable prefix.
  const accounting = event(4, {
    kind: "budget",
    event: "BudgetReconciled",
    workItem: 2,
    attempt: 1,
    phase: "execution",
    unit: "local_milliseconds",
    amount: 50,
  });
  const events = [start, reserved, terminal, accounting];
  const predecessor = {
    runId: "source",
    startDigest: recoveryEventDigest(start),
    terminalDigest: recoveryEventDigest(terminal),
    terminalEvent: "FactoryRunEscalated",
    terminalSequence: 3,
  };
  const history = [{ ...predecessor, policyDigest: policyDigest(policy) }];
  const items = [
    {
      workItem: 2,
      issueNodeId: "issue-2",
      compilerId: "item",
      action: "execute" as const,
      source: null,
      observedPullRequest: null,
      resources: {
        state: "unknown" as const,
        receiptDigest: null,
        identities: [],
      },
    },
  ];
  const allowance = {
    modelTokens: policy.economics?.maxModelTokens ?? null,
    sandboxMinutes: policy.maxSandboxMinutes,
    managedSessions: policy.maxManagedAgentSessions,
    implementationAttemptsPerItem: policy.maxAttemptsPerItem,
  };
  const plan = parseRecoveryPlan({
    protocol: "clockgrove.factory/recovery-plan-v1",
    repository,
    repositoryId: "repository-1",
    objective: 1,
    objectiveNodeId: "objective-1",
    requestId: "request",
    successorRunId: recoverySuccessorRunId(repository, 1, "request"),
    predecessor,
    history,
    historyDigest: recoveryHistoryDigest(history as RecoveryPlan["history"]),
    sourceEventMaxSequence: 4,
    sourceEventsDigest: recoverySourceEventsDigest({
      objective: 1,
      runIds: ["source"],
      events,
      maxSequence: 4,
    }),
    priorPlanDigest: null,
    expectedBaseSha: sha("a"),
    baseBranch: "main",
    graph: {
      sourceRunId: "source",
      ref: compiledGraphRef(1, "source"),
      commitOid: sha("b"),
      blobOid: sha("c"),
      digest: digest("b"),
      projection: {
        ref: compiledGraphProjectionRef(1, "source"),
        commitOid: sha("d"),
        blobOid: sha("e"),
        bindingDigest: recoveryPlanBindingDigest(items),
      },
    },
    acceptedPolicy: policy,
    policyDigest: policyDigest(policy),
    allowance: {
      before: allowance,
      increment: {
        modelTokens: 0,
        sandboxMinutes: 0,
        managedSessions: 0,
        implementationAttemptsPerItem: 0,
      },
      after: allowance,
    },
    unknownUsageAcknowledgementDigest: null,
    items,
  });
  const snapshot: FactoryReadSnapshot = {
    id: plan.objectiveNodeId,
    number: 1,
    title: "Disposable recovery fixture",
    repositoryId: plan.repositoryId,
    authorLogin: "operator",
    defaultBranch: "main",
    closed: false,
    factoryEvents: events,
    workItems: [{ id: "issue-2", number: 2, factoryEvents: [] }],
  };
  const request = event(5, {
    kind: "recovery",
    event: "RecoveryRequested",
    requestId: plan.requestId,
    requestedBy: "operator",
    repository,
    planDigest: recoveryPlanDigest(plan),
    predecessorRunId: "source",
    predecessorTerminalDigest: plan.predecessor.terminalDigest,
    successorRunId: plan.successorRunId,
    policyDigest: plan.policyDigest,
    baseSha: plan.expectedBaseSha,
  });
  const successorStart = parseFactoryEvent({
    ...start,
    sequence: 6,
    runId: plan.successorRunId,
    recoveryRequestId: plan.requestId,
    recoveryPlanDigest: recoveryPlanDigest(plan),
    predecessorRunId: "source",
  });
  return { plan, snapshot, host, events, request, successorStart };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Real immutable Git record bytes; no eligibility/adoption boolean is substituted. */
function planStore(plan: RecoveryPlan): CompiledGraphReadStore {
  return {
    readRef: async (ref) =>
      ref === recoveryPlanRef(plan.objective, recoveryPlanDigest(plan)) ? sha("f") : null,
    readCommit: async (oid) => {
      expect(oid).toBe(sha("f"));
      return {
        oid,
        treeOid: sha("e"),
        parentOids: [plan.expectedBaseSha],
        message: "immutable proposal",
        serverTime: new Date(at),
      };
    },
    readTreeEntry: async (oid, path) => {
      expect(oid).toBe(sha("e"));
      expect(path).toBe(".clockgrove-factory/control/recovery-plan.json");
      return sha("d");
    },
    readBlob: async (oid) => {
      expect(oid).toBe(sha("d"));
      return Buffer.from(canonical(plan));
    },
  };
}

describe("controller retirement source binding", () => {
  it("binds the approved prefix including post-terminal accounting, not terminal sequence alone", () => {
    const input = fixture();
    expect(input.plan.sourceEventMaxSequence).toBeGreaterThan(
      input.plan.predecessor.terminalSequence,
    );
    expect(
      sourceUsesCurrentProducer({
        ...input,
        expectedUnit: input.host.producerUnit!,
      }),
    ).toBe(true);
    const snapshot = {
      ...input.snapshot,
      factoryEvents: input.events.slice(0, 3),
    };
    expect(
      sourceUsesCurrentProducer({
        ...input,
        snapshot,
        expectedUnit: input.host.producerUnit!,
      }),
    ).toBe(false);
  });

  it.each([
    "producerPid",
    "producerStartTicks",
    "hostIdentity",
    "producerUnit",
    "producerInvocationId",
  ] as const)("does not retire another %s generation", (field) => {
    const input = fixture();
    const replacements = {
      producerPid: 124,
      producerStartTicks: "457",
      hostIdentity: digest("e"),
      producerUnit: "foreign.service",
      producerInvocationId: "f".repeat(32),
    };
    const host = { ...input.host, [field]: replacements[field] };
    expect(
      sourceUsesCurrentProducer({
        ...input,
        host,
        expectedUnit: input.host.producerUnit!,
      }),
    ).toBe(false);
  });

  it("rejects missing launcher ownership and changed source receipts without increasing allowance", () => {
    const input = fixture();
    const host = {
      hostIdentity: input.host.hostIdentity,
      producerPid: input.host.producerPid,
      producerStartTicks: input.host.producerStartTicks,
    };
    expect(
      sourceUsesCurrentProducer({
        ...input,
        host,
        expectedUnit: input.host.producerUnit!,
      }),
    ).toBe(false);
    const snapshot = {
      ...input.snapshot,
      factoryEvents: [...input.events.slice(0, 3), event(4, { ...input.events[3], amount: 51 })],
    };
    expect(
      sourceUsesCurrentProducer({
        ...input,
        snapshot,
        expectedUnit: input.host.producerUnit!,
      }),
    ).toBe(false);
    expect(input.plan.allowance.before).toEqual(input.plan.allowance.after);
  });
});

describe("acknowledged successor discovery", () => {
  it.each(["pause", "drain"] as const)(
    "rediscovers a closed %s successor to reconcile closure",
    async (command) => {
      const input = fixture();
      const events = [
        ...input.events,
        input.request,
        input.successorStart,
        event(7, {
          runId: input.plan.successorRunId,
          kind: "run",
          event: command === "pause" ? "RunPauseRequested" : "RunDrainRequested",
          requestId: command,
          requestedBy: "operator",
        }),
        event(8, {
          runId: input.plan.successorRunId,
          kind: "run",
          event: command === "pause" ? "RunPauseAcknowledged" : "RunDrainCompleted",
          commandRequestId: command,
        }),
      ];
      const args = {
        repository,
        objective: 1,
        actor: "operator",
        events,
        store: planStore(input.plan),
      };
      expect(await discoverRecoveryActivation({ ...args, closed: false })).toBeNull();
      expect(
        (await discoverRecoveryActivation({ ...args, closed: true }))?.recovery?.successorRunId,
      ).toBe(input.plan.successorRunId);
      expect(
        await discoverRecoveryActivation({
          ...args,
          closed: true,
          events: [
            ...events,
            event(9, {
              kind: "run",
              event: "FactoryRunCancelled",
              runId: input.plan.successorRunId,
            }),
          ],
        }),
      ).toBeNull();
    },
  );
});

// Explicit opt-in: no actual Factory controller is started or changed. This component
// check bundles the real retirement helper into a uniquely named disposable service.
it.runIf(process.env.FACTORY_LIVE_RETIREMENT === "1")(
  "retires only the source generation across a real same-service restart",
  async () => {
    const exec = promisify(execFile);
    const directory = await mkdtemp(join(tmpdir(), "factory-retirement-component-"));
    const unit = new SystemdUserService({
      factoryExecutable: process.execPath,
    }).unitName({ repository, checkout: directory });
    const inputPath = join(directory, "input.json");
    const outputPath = join(directory, "output.json");
    const bundlePath = join(directory, "helper.mjs");
    let owned = false;
    try {
      const before = await exec(
        "systemctl",
        ["--user", "show", unit, "--property=LoadState", "--value"],
        { timeout: 5000 },
      ).catch((error: unknown) => {
        const result = error as { stdout?: string };
        if (result.stdout?.trim() === "not-found") return { stdout: result.stdout };
        throw error;
      });
      expect(before.stdout.trim()).toBe("not-found");
      const input = fixture();
      await writeFile(inputPath, JSON.stringify({ plan: input.plan, snapshot: input.snapshot }));
      const source = `
      import { readFile, writeFile } from 'node:fs/promises';
      import { shouldRetireController, ControllerGenerationRetirement } from ${JSON.stringify(resolve("src/controller/retirement.ts"))};
      import { discoverLocalScopeHost } from ${JSON.stringify(resolve("src/runtime/local-scope.ts"))};
      import { parseFactoryEvent } from ${JSON.stringify(resolve("src/protocol/events.ts"))};
      import { recoverySourceEventsDigest } from ${JSON.stringify(resolve("src/recovery/identity.ts"))};
      const inputPath = ${JSON.stringify(inputPath)}, outputPath = ${JSON.stringify(outputPath)};
      const input = JSON.parse(await readFile(inputPath, 'utf8'));
      const host = await discoverLocalScopeHost();
      if (!host?.producerInvocationId) throw new Error('disposable service host unavailable');
      if (!input.firstInvocation) {
        const reservation = input.snapshot.factoryEvents[1];
        const batch = reservation.localScopeBatch;
        input.snapshot.factoryEvents[1] = parseFactoryEvent({ ...reservation, localScopeBatch: { ...batch,
          producerPid: host.producerPid, producerStartTicks: host.producerStartTicks,
          identity: { ...batch.identity, hostIdentity: host.hostIdentity, producerUnit: host.producerUnit, producerInvocationId: host.producerInvocationId } } });
        input.plan.sourceEventsDigest = recoverySourceEventsDigest({ objective: 1, runIds: ['source'], events: input.snapshot.factoryEvents, maxSequence: input.plan.sourceEventMaxSequence });
        input.firstInvocation = host.producerInvocationId;
        input.firstRetirement = await shouldRetireController({ ...input, checkout: ${JSON.stringify(directory)} });
        await writeFile(inputPath, JSON.stringify(input));
        if (!input.firstRetirement) throw new Error('owned source generation did not retire');
        throw new ControllerGenerationRetirement();
      }
      const secondRetirement = await shouldRetireController({ ...input, checkout: ${JSON.stringify(directory)} });
      await writeFile(outputPath, JSON.stringify({ firstRetirement: input.firstRetirement, secondRetirement, generationChanged: input.firstInvocation !== host.producerInvocationId }));
    `;
      await build({
        stdin: {
          contents: source,
          resolveDir: process.cwd(),
          sourcefile: "retirement-component.ts",
          loader: "ts",
        },
        outfile: bundlePath,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node20",
        logLevel: "silent",
      });
      // Exact missing unit has been verified; ownership remains ours even if start response is lost.
      owned = true;
      await exec(
        "systemd-run",
        [
          "--user",
          `--unit=${unit}`,
          "--collect",
          "--service-type=exec",
          "--property=KillMode=control-group",
          "--property=Restart=on-failure",
          "--property=RestartSec=100ms",
          "--property=RestartPreventExitStatus=2 130",
          "--property=StartLimitIntervalSec=60",
          "--property=StartLimitBurst=2",
          "--property=RuntimeMaxSec=10",
          "--property=CPUQuota=50%",
          "--property=MemoryMax=384M",
          "--property=TasksMax=64",
          "--property=StandardOutput=null",
          "--property=StandardError=null",
          process.execPath,
          bundlePath,
        ],
        { timeout: 5000 },
      );
      const deadline = Date.now() + 20_000;
      let output: unknown;
      while (Date.now() < deadline) {
        try {
          output = JSON.parse(await readFile(outputPath, "utf8"));
          break;
        } catch {
          await new Promise((done) => setTimeout(done, 50));
        }
      }
      expect(output).toEqual({
        firstRetirement: true,
        secondRetirement: false,
        generationChanged: true,
      });
    } finally {
      if (owned) {
        await exec("systemctl", ["--user", "stop", unit], {
          timeout: 5000,
        }).catch(async (error: unknown) => {
          const check = await exec(
            "systemctl",
            ["--user", "show", unit, "--property=LoadState", "--value"],
            { timeout: 5000 },
          ).catch((failure: unknown) => failure as { stdout: string });
          if (check.stdout?.trim() !== "not-found") throw error;
        });
        const state = await exec(
          "systemctl",
          ["--user", "show", unit, "--property=ActiveState,Job,ControlGroup,MainPID"],
          { timeout: 5000 },
        ).catch((error: unknown) => error as { stdout: string });
        expect(state.stdout).toMatch(/^ActiveState=inactive$/m);
        expect(state.stdout).toMatch(/^MainPID=0$/m);
        expect(state.stdout).toMatch(/^ControlGroup=$/m);
        expect(state.stdout).toMatch(/^Job=$/m);
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  35_000,
);
