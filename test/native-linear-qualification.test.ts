import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  assertNativeControllerTakeover,
  assertNativeCancellationBoundary,
  assertNativeLinearControllerAuthority,
  assertNativeLinearCandidate,
  assertNativeLinearFinalTree,
  assertNativeLinearGenerationSets,
  assertNativeLinearHistory,
  assertNativeLinearPublicationProofs,
  assertNativeLinearReview,
  assertNativeLinearSentinelAlive,
  assertNativeLinearTerminal,
  assertNoOpenLiabilities,
  executeNativeLinearControllerCase,
  main,
  nativeLinearObjectiveBody,
  nativeLinearQualification,
  observeNativeLinearProofs,
  startNativeLinearSentinel,
  stopNativeLinearSentinel,
} from "../scripts/verify-native-linear-objective.mjs";
import { qualificationPaths } from "../scripts/verify-live-objective.mjs";

const head = (character: string) => character.repeat(40);
const digest = (character: string) => character.repeat(64);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string =>
  value && typeof value === "object"
    ? Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.keys(value)
          .sort()
          .map(
            (key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
          )
          .join(",")}}`
    : JSON.stringify(value);

function controllerFields(sequence: number, controllerId: string, epoch: number) {
  const fields = {
    objective: 7,
    runId: "run",
    sequence,
    at: "2026-09-18T00:00:00.000Z",
    expiresAt: `2026-09-18T00:${10 + epoch}:00.000Z`,
    observationScope: "repository-controller",
    controllerId,
    epoch,
    controllerPolicyDigest: digest("d"),
    protocolMin: "clockgrove.factory/v2",
    protocolMax: "clockgrove.factory/v2",
    writerHolder: `writer-${epoch}`,
    writerEpoch: epoch,
    writerPolicyDigest: digest("d"),
  };
  return {
    ...fields,
    writerOperationId: hash(
      JSON.stringify([
        fields.objective,
        fields.runId,
        fields.writerHolder,
        fields.writerEpoch,
        fields.writerPolicyDigest,
        fields.sequence,
      ]),
    ),
  };
}

function rebindWriter(event: QualificationEvent) {
  event.writerOperationId = hash(
    JSON.stringify([
      event.objective,
      event.runId,
      event.writerHolder,
      event.writerEpoch,
      event.writerPolicyDigest,
      event.sequence,
    ]),
  );
}

function checkpointRead(
  demand: { ref: string; path: string },
  document: Record<string, unknown>,
  target: string,
) {
  const content = JSON.stringify(document);
  const bytes = Buffer.from(content);
  const blobOid = createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
  const treePaths = [];
  let child = blobOid;
  const parts = demand.path.split("/");
  for (const [index, name] of [...parts].reverse().entries()) {
    const entry = {
      path: name,
      type: index === 0 ? "blob" : "tree",
      mode: index === 0 ? "100644" : "040000",
      sha: child,
    };
    const encoded = Buffer.concat([
      Buffer.from(`${entry.mode.replace(/^0/, "")} ${name}\0`),
      Buffer.from(child, "hex"),
    ]);
    child = createHash("sha1")
      .update(Buffer.from(`tree ${encoded.length}\0`))
      .update(encoded)
      .digest("hex");
    treePaths.unshift({ sha: child, entries: [entry] });
  }
  const oid = head("e");
  return {
    ref: demand.ref,
    commit: { oid, treeOid: child, parentOids: [target], message: "checkpoint" },
    observedRefOid: oid,
    blobOid,
    content,
    treePaths,
  };
}

type QualificationEvent = {
  event: string;
  workItem?: number;
  sequence?: number;
  headSha?: string;
  baseSha?: string;
  outputTreeSha?: string;
  validationDigest?: string;
  evidenceDigest?: string;
  artifactDigest?: string;
  exactHeadValidationDigest?: string;
  pullRequest?: number;
  attempt?: number;
  objective?: number;
  runId?: string;
  epoch?: number;
  controllerPolicyDigest?: string;
  observationScope?: string;
  invalidatedByItem?: string;
  usageId?: string;
  [key: string]: unknown;
};

function publication(
  position: number,
  sequence: number,
  headSha: string,
  baseSha: string,
  validationDigest: string,
): QualificationEvent {
  return {
    event: "PublicationRecorded",
    runId: "run",
    objective: 1,
    workItem: position + 2,
    attempt: 1,
    itemId: ["root", "middle", "top"][position],
    unitId: "linear",
    position,
    ...(position ? { parentItemId: ["root", "middle"][position - 1] } : {}),
    mode: "native-stacks",
    sequence,
    headSha,
    baseSha,
    validationDigest,
  };
}

function history(): QualificationEvent[] {
  const root = publication(0, 10, head("a"), head("0"), digest("a"));
  const middle = publication(1, 11, head("b"), head("a"), digest("b"));
  const top = publication(2, 12, head("c"), head("b"), digest("c"));
  const middleRebased = publication(1, 25, head("d"), head("1"), digest("d"));
  const topFirstRebase = publication(2, 28, head("e"), head("d"), digest("e"));
  const topFinal = publication(2, 34, head("f"), head("2"), digest("f"));
  return [
    root,
    middle,
    top,
    {
      ...root,
      event: "IntegrationCompleted",
      operationId: "linear-stack-operation",
      sequence: 19,
    },
    {
      event: "AttemptIntegrated",
      runId: "run",
      objective: 1,
      workItem: 2,
      attempt: 1,
      headSha: head("1"),
      sequence: 20,
    },
    {
      ...middle,
      event: "ValidationInvalidated",
      sequence: 21,
      invalidatedByItem: "root",
      invalidatedByHeadSha: head("1"),
    },
    {
      ...top,
      event: "ValidationInvalidated",
      sequence: 22,
      invalidatedByItem: "root",
      invalidatedByHeadSha: head("1"),
    },
    {
      event: "ValidationRecorded",
      workItem: 3,
      attempt: 1,
      sequence: 23,
      evidenceDigest: digest("d"),
      baseSha: head("1"),
      outputTreeSha: head("4"),
      passed: true,
    },
    { event: "AttemptPublished", workItem: 3, sequence: 24, headSha: head("d") },
    middleRebased,
    {
      event: "ValidationRecorded",
      workItem: 4,
      attempt: 1,
      sequence: 26,
      evidenceDigest: digest("e"),
      baseSha: head("d"),
      outputTreeSha: head("5"),
      passed: true,
    },
    { event: "AttemptPublished", workItem: 4, sequence: 27, headSha: head("e") },
    topFirstRebase,
    {
      ...middleRebased,
      event: "IntegrationCompleted",
      operationId: "linear-stack-operation",
      sequence: 29,
    },
    {
      event: "AttemptIntegrated",
      runId: "run",
      objective: 1,
      workItem: 3,
      attempt: 1,
      headSha: head("2"),
      sequence: 30,
    },
    {
      ...topFirstRebase,
      event: "ValidationInvalidated",
      sequence: 31,
      invalidatedByItem: "middle",
      invalidatedByHeadSha: head("2"),
    },
    {
      event: "ValidationRecorded",
      workItem: 4,
      attempt: 1,
      sequence: 32,
      evidenceDigest: digest("f"),
      baseSha: head("2"),
      outputTreeSha: head("6"),
      passed: true,
    },
    { event: "AttemptPublished", workItem: 4, sequence: 33, headSha: head("f") },
    topFinal,
    {
      ...topFinal,
      event: "IntegrationCompleted",
      operationId: "linear-stack-operation",
      sequence: 39,
    },
    {
      event: "AttemptIntegrated",
      runId: "run",
      objective: 1,
      workItem: 4,
      attempt: 1,
      headSha: head("3"),
      sequence: 40,
    },
    ...["one", "two", "three"].flatMap((suffix, index) => [
      {
        event: "BudgetReconciled",
        usageId: `integration-validation-${suffix}`,
        amount: index,
      },
      { event: "BudgetReconciled", usageId: `rebase-review-${suffix}`, amount: index + 1 },
    ]),
  ];
}

function exactBinding(publication: QualificationEvent, validation: QualificationEvent) {
  return hash(
    JSON.stringify({
      protocol: "clockgrove.factory/exact-head-validation-v1",
      validationDigest: validation.evidenceDigest,
      baseSha: validation.baseSha,
      outputTreeSha: validation.outputTreeSha,
      publishedHeadSha: publication.headSha,
    }),
  );
}

function proofEvents(): QualificationEvent[] {
  const events = history().map((event) => ({
    ...event,
    ...(event.workItem ? { runId: "run", objective: 1, attempt: 1 } : {}),
  }));
  const initial = events.filter((event) => event.event === "PublicationRecorded").slice(0, 3);
  events.push(
    ...initial.map((event, index) => ({
      event: "ValidationRecorded",
      runId: "run",
      objective: 1,
      workItem: event.workItem!,
      attempt: 1,
      sequence: index + 1,
      evidenceDigest: event.validationDigest!,
      baseSha: event.baseSha!,
      outputTreeSha: head(String(index + 7)),
      passed: true,
    })),
    ...initial.map((event, index) => ({
      event: "AttemptPublished",
      runId: "run",
      objective: 1,
      workItem: event.workItem!,
      attempt: 1,
      sequence: index + 4,
      headSha: event.headSha!,
      artifactDigest: digest("9"),
    })),
  );
  for (const event of events.filter((entry) => entry.event === "AttemptPublished")) {
    event.runId = "run";
    event.objective = 1;
    event.attempt = 1;
    event.artifactDigest = digest("9");
  }
  for (const publication of events.filter((event) => event.event === "PublicationRecorded")) {
    publication.pullRequest = publication.workItem!;
    const validation = events.find(
      (event) =>
        event.event === "ValidationRecorded" &&
        event.workItem === publication.workItem &&
        event.evidenceDigest === publication.validationDigest,
    )!;
    publication.exactHeadValidationDigest = exactBinding(publication, validation);
  }
  return events;
}

function controllerInput(caseName: "response-loss-restart" | "active-cancellation") {
  const evidence: {
    objective: { number: number };
    actor: { id: number; login: string };
    qualificationNamespace: string;
    nativeLinearIntervention?: Record<string, unknown>;
  } = {
    objective: { number: 7 },
    actor: { id: 9, login: "operator" },
    qualificationNamespace: "native-linear-case",
  };
  const runRequest = {
    tool: "factory_activate",
    arguments: {
      owner: "example",
      repo: "fixture",
      objectiveNumber: 7,
      requestId: "native-linear-case-activate",
      policy: {},
    },
  };
  const validation = {
    event: "ValidationRecorded",
    runId: "run",
    objective: 7,
    workItem: 3,
    attempt: 1,
    sequence: 23,
    evidenceDigest: digest("b"),
    baseSha: head("1"),
    outputTreeSha: head("2"),
    passed: true,
  };
  const published = {
    event: "AttemptPublished",
    runId: "run",
    objective: 7,
    workItem: 3,
    attempt: 1,
    sequence: 25,
    headSha: head("b"),
    artifactDigest: digest("c"),
  };
  const publication = {
    event: "PublicationRecorded",
    runId: "run",
    objective: 7,
    workItem: 3,
    attempt: 1,
    sequence: 26,
    headSha: head("b"),
    baseSha: head("1"),
    validationDigest: digest("b"),
  };
  const reviewIdentity = {
    kind: "rebase",
    runId: "run",
    objective: 7,
    workItem: 3,
    attempt: 1,
    artifactDigest: digest("c"),
    baseSha: head("1"),
    outputTreeSha: head("2"),
    evidenceDigest: digest("b"),
    headSha: head("b"),
  };
  const reviewIdentityDigest = hash(canonical(reviewIdentity));
  const progressEvents = [
    {
      event: "FactoryRunStarted",
      runId: "run",
      activationRequestId: runRequest.arguments.requestId,
    },
    {
      event: "IntegrationCompleted",
      runId: "run",
      workItem: 2,
      attempt: 1,
      sequence: 19,
      headSha: head("0"),
      operationId: "linear-stack-operation",
    },
    {
      event: "AttemptIntegrated",
      runId: "run",
      objective: 7,
      workItem: 2,
      attempt: 1,
      sequence: 20,
      headSha: head("0"),
    },
    {
      event: "ValidationInvalidated",
      runId: "run",
      objective: 7,
      workItem: 3,
      attempt: 1,
      sequence: 22,
      headSha: head("a"),
      invalidatedByItem: "root",
      invalidatedByHeadSha: head("0"),
    },
    {
      event: "ControllerObserved",
      ...controllerFields(21, "controller-one", 4),
    },
    validation,
    {
      event: "BudgetReconciled",
      runId: "run",
      objective: 7,
      workItem: 3,
      attempt: 1,
      sequence: 24,
      phase: "management",
      unit: "model_tokens",
      usageId: `rebase-review-${reviewIdentityDigest}`,
      amount: 2,
    },
    published,
    publication,
  ];
  const observations = [
    { events: progressEvents, status: { run: { availability: "observed", state: "running" } } },
    {
      events: progressEvents,
      status: {
        run: {
          availability: "observed",
          state: caseName === "response-loss-restart" ? "completed" : "cancelled",
        },
      },
    },
  ];
  return {
    caseName,
    evidence,
    owner: "example",
    repo: "fixture",
    checkout: "/home/operator/fixture",
    runRequest,
    call: vi.fn(async (_name: string, _arguments: Record<string, unknown>) => ({})),
    request: vi.fn(),
    save: vi.fn(),
    observe: vi.fn(async () => observations.shift()!),
    wait: vi.fn(async () => {}),
    maximumObservations: 3,
  };
}

describe("native linear-stack installed matrix", () => {
  it("defines one explicit linear Objective without provider or fallback scope", () => {
    const namespace = "native-linear-fixture";
    const body = nativeLinearObjectiveBody(namespace);
    const paths = qualificationPaths(namespace);
    expect(paths.files.every((path) => body.includes(path))).toBe(true);
    expect(body).toContain("The first is the only root");
    expect(body).toContain("depends only on the first");
    expect(body).toContain("depends only on the second");
    expect(body).not.toMatch(/Daytona|fallback|unavailable/i);
    expect(
      nativeLinearQualification({
        FACTORY_LIVE_NATIVE_LINEAR_OBJECTIVE: "1",
        FACTORY_LIVE_OBJECTIVE_PREFLIGHT: "1",
        FACTORY_LIVE_NATIVE_LINEAR_CASE: "cascade",
        FACTORY_LIVE_OBJECTIVE_NAMESPACE: namespace,
        FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS: "250000",
      }),
    ).toMatchObject({
      scope: "installed-local-native-linear-stack-cascade",
      namespace,
      privateEvidence: true,
      harnessPaths: expect.arrayContaining([
        "scripts/verify-native-linear-objective.mjs",
        "scripts/verify-live-objective.mjs",
        "scripts/qualification-reservation-authority.mjs",
        "scripts/verify-local-faults.mjs",
      ]),
    });
  });

  it("forwards exact retained-install and transcript authority before any live work", async () => {
    const env = {
      FACTORY_LIVE_NATIVE_LINEAR_OBJECTIVE: "1",
      FACTORY_LIVE_OBJECTIVE_PREFLIGHT: "1",
      FACTORY_LIVE_NATIVE_LINEAR_CASE: "cascade",
      FACTORY_LIVE_OBJECTIVE_NAMESPACE: "native-linear-authority",
      FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS: "250000",
      FACTORY_QUALIFICATION_INSTALL_RECEIPT: "/private/exact/install-identities.txt",
      FACTORY_MANAGEMENT_TRANSCRIPT_DIR: "/private/exact/management-transcripts",
    };
    const prior = process.env.FACTORY_QUALIFICATION_INSTALL_RECEIPT;
    const priorTranscripts = process.env.FACTORY_MANAGEMENT_TRANSCRIPT_DIR;
    process.env.FACTORY_QUALIFICATION_INSTALL_RECEIPT = "/drifted/global/receipt.txt";
    process.env.FACTORY_MANAGEMENT_TRANSCRIPT_DIR = "/drifted/global/transcripts";
    const run = vi.fn(async (_qualification, options) => {
      expect(options.env).toBe(env);
      expect(options.env.FACTORY_QUALIFICATION_INSTALL_RECEIPT).toBe(
        "/private/exact/install-identities.txt",
      );
      expect(options.env.FACTORY_MANAGEMENT_TRANSCRIPT_DIR).toBe(
        "/private/exact/management-transcripts",
      );
    });
    try {
      await main(env, run);
    } finally {
      if (prior === undefined) delete process.env.FACTORY_QUALIFICATION_INSTALL_RECEIPT;
      else process.env.FACTORY_QUALIFICATION_INSTALL_RECEIPT = prior;
      if (priorTranscripts === undefined) delete process.env.FACTORY_MANAGEMENT_TRANSCRIPT_DIR;
      else process.env.FACTORY_MANAGEMENT_TRANSCRIPT_DIR = priorTranscripts;
    }
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("binds controller status and exact running argv to the retained candidate", () => {
    const artifactIdentity = `sha256:${digest("a")}`;
    const receiptIdentity = `sha256:${digest("e")}`;
    const npmBundle = "/retained/npm/dist/factory.js";
    const pluginBundle = "/retained/plugin/dist/factory.js";
    const controller = {
      unit: "factory.service",
      installed: true,
      enabled: true,
      active: true,
      healthy: true,
      launcherCurrent: true,
      reasonCode: null,
      executableIdentity: artifactIdentity,
      currentExecutableIdentity: artifactIdentity,
    };
    const checkout = "/home/operator/project";
    const expectedArgv = [
      process.execPath,
      npmBundle,
      "controller",
      "run",
      "example/fixture",
      "--repo",
      checkout,
      "--executable-identity",
      artifactIdentity,
    ];
    const argvWithBundle = (bundle: string) =>
      expectedArgv.map((value, index) => (index === 1 ? bundle : value));
    const evidence = {
      repository: "example/fixture",
      installedCandidate: {
        factoryArtifactIdentity: artifactIdentity,
        installReceiptIdentity: receiptIdentity,
        artifactAuthority: {
          factoryBundleSurfaces: [
            {
              surface: "npm",
              path: npmBundle,
              sha256: digest("a"),
              installReceiptIdentity: receiptIdentity,
            },
            {
              surface: "plugin-cache",
              path: pluginBundle,
              sha256: digest("a"),
              installReceiptIdentity: receiptIdentity,
            },
          ],
        },
      },
    };
    expect(
      assertNativeLinearControllerAuthority(controller, evidence, checkout, {
        pid: () => 123,
        argv: () => expectedArgv,
        launcher: () => realpathSync(process.execPath),
        bundle: () => ({ path: npmBundle, sha256: digest("a") }),
      }),
    ).toMatchObject({
      pid: 123,
      artifactIdentity,
      installSurface: "npm",
      authenticatedDigest: artifactIdentity,
      expectedReceiptIdentity: receiptIdentity,
    });
    expect(
      assertNativeLinearControllerAuthority(controller, evidence, checkout, {
        pid: () => 123,
        argv: () => argvWithBundle(pluginBundle),
        launcher: () => realpathSync(process.execPath),
        bundle: () => ({ path: pluginBundle, sha256: digest("a") }),
      }),
    ).toMatchObject({ installSurface: "plugin-cache" });
    expect(() =>
      assertNativeLinearControllerAuthority(controller, evidence, checkout, {
        pid: () => 123,
        argv: () => [...expectedArgv.slice(0, -1), `sha256:${digest("b")}`],
        launcher: () => realpathSync(process.execPath),
        bundle: () => ({ path: npmBundle, sha256: digest("a") }),
      }),
    ).toThrow();
    expect(() =>
      assertNativeLinearControllerAuthority(controller, evidence, checkout, {
        pid: () => 123,
        argv: () => argvWithBundle("/unbound/dist/factory.js"),
        launcher: () => realpathSync(process.execPath),
        bundle: () => ({ path: "/unbound/dist/factory.js", sha256: digest("a") }),
      }),
    ).toThrow(/outside retained install surfaces/);
    expect(() =>
      assertNativeLinearControllerAuthority(controller, evidence, checkout, {
        pid: () => 123,
        argv: () => expectedArgv,
        launcher: () => realpathSync(process.execPath),
        bundle: () => ({ path: npmBundle, sha256: digest("b") }),
      }),
    ).toThrow(/digest differs/);
    const staleReceipt = structuredClone(evidence);
    staleReceipt.installedCandidate.artifactAuthority
      .factoryBundleSurfaces[0]!.installReceiptIdentity = `sha256:${digest("f")}`;
    expect(() =>
      assertNativeLinearControllerAuthority(controller, staleReceipt, checkout, {
        pid: () => 123,
        argv: () => expectedArgv,
        launcher: () => realpathSync(process.execPath),
        bundle: () => ({ path: npmBundle, sha256: digest("a") }),
      }),
    ).toThrow(/receipt differs/);
  });

  it.each(["", "other", "native-unavailable"])(
    "rejects unknown matrix case %j before installed execution",
    (caseName) => {
      expect(() =>
        nativeLinearQualification({
          FACTORY_LIVE_NATIVE_LINEAR_OBJECTIVE: "1",
          FACTORY_LIVE_OBJECTIVE_PREFLIGHT: "1",
          FACTORY_LIVE_NATIVE_LINEAR_CASE: caseName,
          FACTORY_LIVE_OBJECTIVE_NAMESPACE: "native-linear-fixture",
          FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS: "250000",
        }),
      ).toThrow();
    },
  );

  it("keeps native unavailability in its separate qualification", () => {
    expect(() =>
      nativeLinearQualification({
        FACTORY_LIVE_NATIVE_LINEAR_OBJECTIVE: "1",
        FACTORY_LIVE_NATIVE_FALLBACK_OBJECTIVE: "1",
        FACTORY_LIVE_OBJECTIVE_PREFLIGHT: "1",
        FACTORY_LIVE_NATIVE_LINEAR_CASE: "cascade",
        FACTORY_LIVE_OBJECTIVE_NAMESPACE: "native-linear-fixture",
        FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS: "250000",
      }),
    ).toThrow(/separate fallback qualification/);
  });

  it("requires one invalidation/revalidation per lower-layer change and bottom-up completion", () => {
    expect(() => assertNativeLinearHistory(history())).not.toThrow();
  });

  it.each([
    [
      "missing invalidation",
      (events: ReturnType<typeof history>) =>
        events.splice(
          events.findIndex(
            (event) => event.event === "ValidationInvalidated" && event.workItem === 4,
          ),
          1,
        ),
    ],
    [
      "changed-head reuse",
      (events: ReturnType<typeof history>) => {
        const publications = events.filter(
          (event) => event.event === "PublicationRecorded" && event.workItem === 3,
        );
        publications[1]!.headSha = publications[0]!.headSha!;
      },
    ],
    [
      "duplicate native mutation",
      (events: ReturnType<typeof history>) => {
        events.push(
          structuredClone(
            events.find((event) => event.event === "IntegrationCompleted" && event.workItem === 3)!,
          ),
        );
      },
    ],
    [
      "cascade order",
      (events: ReturnType<typeof history>) => {
        const invalidations = events.filter(
          (event) => event.event === "ValidationInvalidated" && event.workItem === 4,
        );
        invalidations.reverse().forEach((event, index) => {
          event.invalidatedByItem = ["root", "middle"][index]!;
        });
      },
    ],
    [
      "partial completion order",
      (events: ReturnType<typeof history>) => {
        events.find(
          (event) => event.event === "AttemptIntegrated" && event.workItem === 3,
        )!.sequence = 19;
      },
    ],
    [
      "unbound lower merge identity",
      (events: ReturnType<typeof history>) => {
        events.find(
          (event) => event.event === "ValidationInvalidated" && event.workItem === 3,
        )!.invalidatedByHeadSha = head("9");
      },
    ],
  ] as const)("rejects deterministic %s evidence", (_name, mutate) => {
    const events = history();
    mutate(events);
    expect(() => assertNativeLinearHistory(events)).toThrow();
  });

  it("binds the merged default-branch tree to the final validated top tree", () => {
    expect(assertNativeLinearFinalTree(history(), head("6"))).toMatchObject({
      validation: { outputTreeSha: head("6") },
    });
    expect(() => assertNativeLinearFinalTree(history(), head("7"))).toThrow(
      /validated top output tree/,
    );
  });

  it("observes every initial and rewritten publication, including the top intermediate rebase", async () => {
    const events = proofEvents();
    const rawEvents = events
      .filter((event) => event.runId === "run")
      .map((event, index) => ({
        ...event,
        author: "operator",
        authorId: 9,
        receiptUrl: `https://github.com/example/fixture/issues/${event.workItem ?? 1}#issuecomment-${index + 1}`,
      }));
    const evidence: {
      nativeLinearProofs?: Array<Record<string, unknown>>;
      mergeProofs?: Array<Record<string, unknown>>;
      [key: string]: unknown;
    } = {
      repository: "example/fixture",
      actor: { id: 9, login: "operator" },
      objective: { number: 1 },
      children: [{ number: 2 }, { number: 3 }, { number: 4 }],
      events: rawEvents,
      runResult: { runId: "run" },
      runRequest: { tool: "factory_run", arguments: {} },
      pulls: [2, 3, 4].map((number) => ({
        number,
        node_id: `pull-${number}`,
        base: { repo: { node_id: "repo-node" } },
      })),
    };
    const validationByHead = new Map(
      events
        .filter((event) => event.event === "PublicationRecorded")
        .map((publication) => [
          publication.headSha,
          events.find(
            (event) =>
              event.event === "ValidationRecorded" &&
              event.workItem === publication.workItem &&
              event.evidenceDigest === publication.validationDigest,
          )!,
        ]),
    );
    const read = vi.fn(async (demand: Record<string, unknown>) => {
      if (demand.kind === "checkpoint")
        return {
          demand,
          ...(String(demand.path).endsWith("merge-candidate.json")
            ? {
                content: JSON.stringify({
                  validation: {
                    artifactDigest: digest("9"),
                    outputTreeSha: head("8"),
                    digest: digest("8"),
                  },
                }),
              }
            : {}),
        };
      const validation = validationByHead.get(String(demand.oid))!;
      return {
        oid: demand.oid,
        treeOid: validation.outputTreeSha,
        parentOids: [validation.baseSha],
        message: "qualification fixture",
      };
    });
    await observeNativeLinearProofs(
      { evidence, request: vi.fn() },
      read,
      async (expected) => expected,
    );
    expect(evidence.nativeLinearProofs).toHaveLength(6);
    expect(evidence.nativeLinearProofs).toEqual(
      expect.arrayContaining([expect.objectContaining({ position: 2, publicationIndex: 1 })]),
    );
    expect(evidence.nativeLinearProofs!.filter((proof) => proof.reviewDemand)).toHaveLength(6);

    const missing = structuredClone(evidence);
    missing.nativeLinearProofs!.splice(4, 1);
    expect(() => assertNativeLinearPublicationProofs(missing, events)).toThrow(/coverage/);

    const changedCommit = structuredClone(evidence);
    (changedCommit.nativeLinearProofs![0]!.commitRead as Record<string, unknown>).parentOids = [
      head("9"),
    ];
    expect(() => assertNativeLinearPublicationProofs(changedCommit, events)).toThrow();

    const changedDigest = structuredClone(evidence);
    const changedDigestEvents = structuredClone(events);
    const changedPublication = changedDigest.nativeLinearProofs![0]!
      .publication as QualificationEvent;
    changedPublication.exactHeadValidationDigest = digest("0");
    changedDigestEvents.find(
      (event) =>
        event.event === "PublicationRecorded" &&
        event.workItem === changedPublication.workItem &&
        event.headSha === changedPublication.headSha,
    )!.exactHeadValidationDigest = digest("0");
    expect(() => assertNativeLinearPublicationProofs(changedDigest, changedDigestEvents)).toThrow(
      /exact-head validation binding/,
    );
  });

  it("rejects fresh-digest and fresh-usage restart duplicates outside all six generations", () => {
    const events = proofEvents();
    const publications = events
      .filter((event) => event.event === "PublicationRecorded")
      .sort((left, right) => left.sequence! - right.sequence!);
    const counts = new Map<number, number>();
    const proofs: Array<{
      publication: QualificationEvent;
      publicationIndex: number;
      validation: QualificationEvent;
      integration?: { sequence: number };
      candidateIdentityDigest?: string;
      candidateReviewIdentityDigest?: string;
    }> = publications.map((published) => {
      const publicationIndex = counts.get(published.workItem!) ?? 0;
      counts.set(published.workItem!, publicationIndex + 1);
      const validation = events.find(
        (event) =>
          event.event === "ValidationRecorded" &&
          event.workItem === published.workItem &&
          event.evidenceDigest === published.validationDigest,
      )!;
      const attempt = events.find(
        (event) =>
          event.event === "AttemptPublished" &&
          event.workItem === published.workItem &&
          event.headSha === published.headSha,
      )!;
      const identity = {
        kind: publicationIndex === 0 ? "artifact" : "rebase",
        runId: published.runId,
        objective: published.objective,
        workItem: published.workItem!,
        attempt: published.attempt,
        artifactDigest: attempt.artifactDigest,
        baseSha: validation.baseSha,
        outputTreeSha: validation.outputTreeSha,
        evidenceDigest: validation.evidenceDigest,
        ...(publicationIndex === 0 ? {} : { headSha: published.headSha }),
      };
      const reviewDigest = hash(canonical(identity));
      events.push({
        event: "BudgetReconciled",
        runId: "run",
        objective: 1,
        workItem: published.workItem!,
        attempt: 1,
        phase: "management",
        unit: "model_tokens",
        usageId: `${publicationIndex === 0 ? "review" : "rebase-review"}-${reviewDigest}`,
      });
      return { publication: published, publicationIndex, validation };
    });
    for (const proof of proofs.filter((entry) =>
      [head("a"), head("d"), head("f")].includes(String(entry.publication.headSha)),
    )) {
      proof.integration = { sequence: 200 };
      proof.candidateIdentityDigest = hash(`candidate-${proof.publication.workItem}`);
      proof.candidateReviewIdentityDigest = hash(`candidate-review-${proof.publication.workItem}`);
      events.push(
        {
          event: "BudgetReconciled",
          runId: "run",
          usageId: `integration-validation-${proof.candidateIdentityDigest}`,
        },
        {
          event: "BudgetReconciled",
          runId: "run",
          usageId: `integration-review-${proof.candidateReviewIdentityDigest}`,
        },
      );
    }
    const evidence = { runResult: { runId: "run" }, nativeLinearProofs: proofs };
    expect(() => assertNativeLinearGenerationSets(evidence, events)).not.toThrow();
    const restarted = structuredClone(events);
    restarted.push(
      {
        event: "ValidationRecorded",
        runId: "run",
        objective: 1,
        workItem: 4,
        attempt: 1,
        sequence: 300,
        evidenceDigest: digest("1"),
        baseSha: head("3"),
        outputTreeSha: head("9"),
        passed: true,
      },
      {
        event: "AttemptPublished",
        runId: "run",
        objective: 1,
        workItem: 4,
        attempt: 1,
        sequence: 301,
        headSha: head("9"),
        artifactDigest: digest("1"),
      },
      { event: "BudgetReconciled", runId: "run", usageId: `rebase-review-${digest("1")}` },
      {
        event: "BudgetReconciled",
        runId: "run",
        usageId: `integration-validation-${digest("1")}`,
      },
      {
        event: "BudgetReconciled",
        runId: "run",
        usageId: `integration-review-${digest("1")}`,
      },
    );
    expect(() => assertNativeLinearGenerationSets(evidence, restarted)).toThrow(/unmatched/);
  });

  it("binds every rewritten-head review decision and accounting to its exact identity", () => {
    const events = proofEvents();
    const publication = events.find(
      (event) =>
        event.event === "PublicationRecorded" &&
        event.workItem === 3 &&
        event.headSha === head("d"),
    )!;
    const validation = events.find(
      (event) =>
        event.event === "ValidationRecorded" &&
        event.workItem === publication.workItem &&
        event.evidenceDigest === publication.validationDigest,
    )!;
    const published = events.find(
      (event) =>
        event.event === "AttemptPublished" &&
        event.workItem === publication.workItem &&
        event.headSha === publication.headSha,
    )!;
    published.sequence = 25;
    publication.sequence = 26;
    const identity = {
      kind: "rebase",
      runId: publication.runId,
      objective: publication.objective,
      workItem: publication.workItem,
      attempt: publication.attempt,
      artifactDigest: published.artifactDigest,
      baseSha: validation.baseSha,
      outputTreeSha: validation.outputTreeSha,
      evidenceDigest: validation.evidenceDigest,
      headSha: publication.headSha,
    };
    const identityDigest = hash(canonical(identity));
    const review = {
      protocol: "clockgrove.factory/review-checkpoint-v1",
      identityDigest,
      identity,
      review: { accepted: true, unmetCriteria: [] },
      usage: { inputTokens: 5, outputTokens: 3 },
    };
    const reviewEvents = [
      ...events.filter(
        (event) =>
          !(
            event.event === "BudgetReconciled" &&
            typeof event.usageId === "string" &&
            event.usageId.startsWith("rebase-review-")
          ),
      ),
      {
        event: "BudgetReconciled",
        runId: publication.runId,
        objective: publication.objective,
        workItem: publication.workItem,
        attempt: publication.attempt,
        phase: "management",
        unit: "model_tokens",
        usageId: `rebase-review-${identityDigest}`,
        amount: 8,
        sequence: 24,
      },
    ];
    expect(assertNativeLinearReview(review, publication, validation, published, reviewEvents)).toBe(
      identityDigest,
    );
    expect(() =>
      assertNativeLinearReview(
        { ...review, review: { accepted: false, unmetCriteria: ["missing"] } },
        publication,
        validation,
        published,
        reviewEvents,
      ),
    ).toThrow();
    expect(() =>
      assertNativeLinearReview(
        { ...review, identityDigest: digest("0") },
        publication,
        validation,
        published,
        reviewEvents,
      ),
    ).toThrow();
    expect(() =>
      assertNativeLinearReview(
        { ...review, usage: { inputTokens: 0, outputTokens: 3 } },
        publication,
        validation,
        published,
        reviewEvents,
      ),
    ).toThrow(/positive exact counter/);
    expect(() =>
      assertNativeLinearReview(
        { ...review, usage: { inputTokens: 5, outputTokens: 3, cachedInputTokens: 6 } },
        publication,
        validation,
        published,
        reviewEvents,
      ),
    ).toThrow(/cached input/);
    const wrongAmount = structuredClone(reviewEvents);
    wrongAmount.at(-1)!.amount = 7;
    expect(() =>
      assertNativeLinearReview(review, publication, validation, published, wrongAmount),
    ).toThrow();
    const stale = structuredClone(reviewEvents);
    stale.at(-1)!.sequence = validation.sequence!;
    expect(() =>
      assertNativeLinearReview(review, publication, validation, published, stale),
    ).toThrow(/fence/);
    reviewEvents.at(-1)!.usageId = `rebase-review-${digest("f")}`;
    expect(() =>
      assertNativeLinearReview(review, publication, validation, published, reviewEvents),
    ).toThrow(/accounting/);
  });

  it("requires an exact positive semantic review for an initial publication", () => {
    const initialPublication = publication(0, 5, head("a"), head("0"), digest("a"));
    const validation = {
      event: "ValidationRecorded",
      runId: "run",
      objective: 1,
      workItem: 2,
      attempt: 1,
      sequence: 2,
      baseSha: head("0"),
      outputTreeSha: head("7"),
      evidenceDigest: digest("a"),
      passed: true,
    };
    const published = {
      event: "AttemptPublished",
      runId: "run",
      objective: 1,
      workItem: 2,
      attempt: 1,
      sequence: 4,
      headSha: head("a"),
      artifactDigest: digest("9"),
    };
    const identity = {
      kind: "artifact",
      runId: "run",
      objective: 1,
      workItem: 2,
      attempt: 1,
      artifactDigest: digest("9"),
      baseSha: head("0"),
      outputTreeSha: head("7"),
      evidenceDigest: digest("a"),
    };
    const identityDigest = hash(canonical(identity));
    const review = {
      protocol: "clockgrove.factory/review-checkpoint-v1",
      identity,
      identityDigest,
      review: { accepted: true, unmetCriteria: [] },
      usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 1 },
    };
    const accounting = [
      {
        event: "BudgetReconciled",
        runId: "run",
        objective: 1,
        workItem: 2,
        attempt: 1,
        phase: "management",
        unit: "model_tokens",
        usageId: `review-${identityDigest}`,
        amount: 5,
        sequence: 3,
      },
    ];
    expect(
      assertNativeLinearReview(review, initialPublication, validation, published, accounting, 0),
    ).toBe(identityDigest);
  });

  it("binds integration validation accounting to the exact final candidate", () => {
    const published = publication(0, 10, head("a"), head("0"), digest("a"));
    published.pullRequest = 2;
    published.exactHeadValidationDigest = exactBinding(published, {
      event: "ValidationRecorded",
      evidenceDigest: digest("a"),
      baseSha: head("0"),
      outputTreeSha: head("7"),
      passed: true,
    });
    const sourceValidation = { outputTreeSha: head("7") };
    const identity = {
      runId: "run",
      objective: 1,
      workItem: 2,
      attempt: 1,
      pullRequest: 2,
      sourceHeadSha: head("a"),
      sourceExactHeadValidationDigest: published.exactHeadValidationDigest,
      targetBaseSha: head("0"),
      deliveryHeadSha: head("a"),
    };
    const identityDigest = hash(JSON.stringify(identity));
    const demand = {
      kind: "checkpoint",
      ref:
        `refs/clockgrove-factory/merge-candidates/objective-1/` +
        `work-item-2/attempt-1/candidate-${identityDigest}`,
      path: ".clockgrove-factory/control/merge-candidate.json",
      maxBytes: 512 * 1024,
    };
    const validationCore = {
      protocol: "clockgrove.factory/validation-v1",
      artifactDigest: digest("9"),
      baseSha: head("0"),
      outputTreeSha: head("7"),
      commands: [{ command: "npm test", exitCode: 0, durationMs: 5000 }],
      passed: true,
      startedAt: "2026-09-18T00:00:00.000Z",
      completedAt: "2026-09-18T00:00:05.000Z",
    };
    const validation = { ...validationCore, digest: hash(JSON.stringify(validationCore)) };
    const sourceCore = {
      protocol: "clockgrove.factory/exact-head-validation-v1",
      validationDigest: digest("a"),
      baseSha: head("0"),
      outputTreeSha: head("7"),
      publishedHeadSha: head("a"),
    };
    const source = { ...sourceCore, digest: hash(JSON.stringify(sourceCore)) };
    const bound = {
      protocol: "clockgrove.factory/merge-candidate-validation-v1",
      sourceExactHeadValidationDigest: source.digest,
      sourceBaseSha: source.baseSha,
      sourceHeadSha: source.publishedHeadSha,
      sourceTreeSha: source.outputTreeSha,
      targetBaseSha: head("0"),
      candidateOutputTreeSha: head("7"),
      candidateArtifactDigest: validation.artifactDigest,
      candidateValidationDigest: validation.digest,
    };
    const document = {
      protocol: "clockgrove.factory/merge-candidate-checkpoint-v1",
      identity,
      identityDigest,
      source,
      validation,
      evidence: { ...bound, digest: hash(JSON.stringify(bound)) },
    };
    const candidateReviewIdentity = {
      kind: "integration-candidate",
      runId: "run",
      objective: 1,
      workItem: 2,
      attempt: 1,
      artifactDigest: validation.artifactDigest,
      baseSha: head("0"),
      outputTreeSha: head("7"),
      evidenceDigest: validation.digest,
      headSha: head("a"),
    };
    const candidateReviewIdentityDigest = hash(canonical(candidateReviewIdentity));
    const candidateReviewDemand = {
      kind: "checkpoint",
      ref:
        `refs/clockgrove-factory/reviews/objective-1/work-item-2/attempt-1/` +
        `integration-candidate-${candidateReviewIdentityDigest}`,
      path: ".clockgrove-factory/control/semantic-review.json",
      maxBytes: 65_536,
    };
    const candidateReview = {
      protocol: "clockgrove.factory/review-checkpoint-v1",
      identity: candidateReviewIdentity,
      identityDigest: candidateReviewIdentityDigest,
      review: { accepted: true, unmetCriteria: [] },
      usage: { inputTokens: 4, outputTokens: 2, cachedInputTokens: 1 },
    };
    const proof = {
      publication: published,
      validation: sourceValidation,
      sourcePublication: published,
      sourceValidation,
      integration: { sequence: 14 },
      candidateIdentity: identity,
      candidateIdentityDigest: identityDigest,
      candidateDemand: demand,
      candidateRead: checkpointRead(demand, document, head("0")),
      candidateReviewIdentity,
      candidateReviewIdentityDigest,
      candidateReviewDemand,
      candidateReviewRead: checkpointRead(candidateReviewDemand, candidateReview, head("0")),
    };
    const accounting = [
      {
        event: "BudgetReconciled",
        runId: "run",
        objective: 1,
        workItem: 2,
        attempt: 1,
        phase: "validation",
        unit: "validation_milliseconds",
        usageId: `integration-validation-${identityDigest}`,
        amount: 5000,
        sequence: 12,
      },
      {
        event: "BudgetReconciled",
        runId: "run",
        objective: 1,
        workItem: 2,
        attempt: 1,
        phase: "management",
        unit: "model_tokens",
        usageId: `integration-review-${candidateReviewIdentityDigest}`,
        amount: 6,
        sequence: 13,
      },
    ];
    expect(() => assertNativeLinearCandidate(proof, accounting)).not.toThrow();
    for (const mutate of [
      (events: typeof accounting) => (events[0]!.amount = 4999),
      (events: typeof accounting) => (events[0]!.usageId = "integration-validation-other"),
      (events: typeof accounting) => (events[0]!.sequence = 15),
    ]) {
      const changed = structuredClone(accounting);
      mutate(changed);
      expect(() => assertNativeLinearCandidate(proof, changed)).toThrow();
    }
  });

  it("uses standard marker-to-actual model accounting and rejects open or duplicate usage", () => {
    const marker = {
      kind: "budget",
      event: "BudgetReserved",
      objective: 1,
      runId: "run",
      workItem: 2,
      attempt: 1,
      phase: "execution",
      modelInvocationId: "worker-1",
      policyDigest: digest("a"),
      directorEpoch: 1,
      unit: "model_tokens",
      amount: 0,
      usageId: "invocation-worker-1",
      sequence: 1,
    };
    const actual = {
      ...marker,
      event: "BudgetReconciled",
      amount: 8,
      usageId: "worker-actual-1",
      sequence: 2,
      usageEvidence: "as-recorded",
      reportedModelUsage: { inputTokens: 5, outputTokens: 3, cachedInputTokens: 2 },
    };
    expect(assertNoOpenLiabilities([marker, actual])).toMatchObject({ total: 8, unresolved: [] });
    expect(() => assertNoOpenLiabilities([marker])).toThrow(/unresolved/);
    expect(() => assertNoOpenLiabilities([actual])).toThrow(/dispatch marker/);
    expect(() => assertNoOpenLiabilities([marker, actual, { ...actual, sequence: 3 }])).toThrow(
      /repeated|multiple actual/,
    );
  });

  it("rejects conflicting terminal receipts", () => {
    expect(() =>
      assertNativeLinearTerminal(
        [{ event: "FactoryRunCompleted" }, { event: "FactoryRunCancelled" }],
        "completed",
      ),
    ).toThrow(/conflicting/);
  });

  it("authenticates takeover by scope, monotonic generation and pre-advancement observation", () => {
    const trigger = { event: "PublicationRecorded", sequence: 2 };
    const events: QualificationEvent[] = [
      {
        event: "ControllerObserved",
        ...controllerFields(1, "old", 4),
      },
      trigger,
      {
        event: "ControllerObserved",
        ...controllerFields(3, "new", 5),
      },
      { event: "AttemptPublished", sequence: 4 },
    ];
    const expectedEvent = { event: "ControllerObserved", ...controllerFields(1, "old", 4) };
    const expected = Object.fromEntries(
      Object.entries(expectedEvent).filter(
        ([key]) =>
          !["event", "objective", "runId", "sequence", "at", "observationScope"].includes(key),
      ),
    );
    expect(assertNativeControllerTakeover(events, trigger, expected)).toMatchObject({
      after: { controllerId: "new", epoch: 5 },
    });
    for (const mutate of [
      (copy: typeof events) => {
        copy[2]!.epoch = 4;
      },
      (copy: typeof events) => {
        copy[2]!.controllerPolicyDigest = digest("b");
      },
      (copy: typeof events) => {
        copy[2]!.observationScope = "worker";
      },
      (copy: typeof events) => {
        copy[2]!.sequence = 5;
      },
      (copy: typeof events) => {
        copy[2]!.protocolMax = "clockgrove.factory/future";
      },
      (copy: typeof events) => {
        copy[2]!.writerOperationId = digest("f");
      },
      (copy: typeof events) => {
        copy[2]!.writerEpoch = 3;
        rebindWriter(copy[2]!);
      },
      (copy: typeof events) => {
        copy[2]!.writerEpoch = 4;
        copy[2]!.writerHolder = "drifted-same-writer-epoch";
        rebindWriter(copy[2]!);
      },
      (copy: typeof events) => {
        copy[2]!.writerPolicyDigest = digest("e");
        rebindWriter(copy[2]!);
      },
    ]) {
      const copy = structuredClone(events);
      mutate(copy);
      expect(() => assertNativeControllerTakeover(copy, trigger, expected)).toThrow();
    }
    for (const field of ["controllerId", "expiresAt", "protocolMin", "controllerPolicyDigest"]) {
      const copy = structuredClone(events);
      const prior = { event: "ControllerObserved", ...controllerFields(0, "old", 4) };
      copy.unshift(prior);
      if (field === "controllerId") copy[1]!.controllerId = "drifted";
      else if (field === "expiresAt") copy[1]!.expiresAt = "2026-09-18T00:19:00.000Z";
      else if (field === "protocolMin") copy[1]!.protocolMin = "clockgrove.factory/other";
      else copy[1]!.controllerPolicyDigest = digest("e");
      expect(() => assertNativeControllerTakeover(copy, trigger, expected)).toThrow();
    }
  });

  it("keeps an unrelated exact systemd sentinel generation alive, then stops it", () => {
    let state: "absent" | "active" = "absent";
    let invocation = "1".repeat(32);
    const port = {
      unit: () => "clockgrove-qualification-sentinel-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.service",
      now: () => "2026-09-18T00:00:00.000Z",
      run: (file: string, args: string[]) => {
        if (file === "systemd-run") {
          state = "active";
          return "";
        }
        if (args.includes("stop")) {
          state = "absent";
          return "";
        }
        return [
          `Id=${port.unit()}`,
          `LoadState=${state === "active" ? "loaded" : "not-found"}`,
          `ActiveState=${state === "active" ? "active" : "inactive"}`,
          `SubState=${state === "active" ? "running" : "dead"}`,
          `ControlGroup=${state === "active" ? `/user.slice/${port.unit()}` : ""}`,
          "Job=",
          `InvocationID=${state === "active" ? invocation : ""}`,
          "KillMode=control-group",
        ].join("\n");
      },
    };
    const started = startNativeLinearSentinel(port);
    expect(assertNativeLinearSentinelAlive(started, port)).toMatchObject({ status: "active" });
    invocation = "2".repeat(32);
    expect(() => assertNativeLinearSentinelAlive(started, port)).toThrow(/replaced/);
    invocation = String(started.invocationId);
    expect(stopNativeLinearSentinel(started, port)).toMatchObject({ status: "absent" });
  });

  it("accepts only a root-only cancellation boundary with bound proof and sentinel survival", () => {
    const events = proofEvents()
      .filter(
        (event) =>
          event.sequence === undefined ||
          event.sequence <= 25 ||
          (event.event === "ValidationInvalidated" && event.workItem === 4),
      )
      .filter(
        (event) =>
          !(
            event.event === "BudgetReconciled" &&
            typeof event.usageId === "string" &&
            (event.usageId.startsWith("rebase-review-") ||
              event.usageId.startsWith("integration-validation-"))
          ),
      );
    const validation = events.find(
      (event) => event.event === "ValidationRecorded" && event.workItem === 3,
    )!;
    const published = events.find(
      (event) => event.event === "AttemptPublished" && event.workItem === 3,
    )!;
    const publication = events.find(
      (event) =>
        event.event === "PublicationRecorded" &&
        event.workItem === 3 &&
        event.headSha === head("d"),
    )!;
    published.sequence = 25;
    publication.sequence = 26;
    const identity = {
      kind: "rebase",
      runId: "run",
      objective: 1,
      workItem: 3,
      attempt: 1,
      artifactDigest: published.artifactDigest,
      baseSha: validation.baseSha,
      outputTreeSha: validation.outputTreeSha,
      evidenceDigest: validation.evidenceDigest,
      headSha: publication.headSha,
    };
    const identityDigest = hash(canonical(identity));
    events.push(
      {
        event: "ActivationRequested",
        runId: "run",
        objective: 1,
        requestId: "activate-once",
        sequence: 0,
      },
      {
        event: "BudgetReconciled",
        runId: "run",
        objective: 1,
        workItem: 3,
        attempt: 1,
        phase: "management",
        unit: "model_tokens",
        usageId: `rebase-review-${identityDigest}`,
        amount: 2,
        sequence: 24,
      },
      {
        event: "FactoryRunCancellationRequested",
        runId: "run",
        objective: 1,
        requestId: "cancel-once",
        sequence: 30,
      },
    );
    const pull = {
      number: 2,
      node_id: "pull-2",
      merged: true,
      state: "closed",
      merged_at: "2026-09-18T00:00:00Z",
      head: { sha: head("a") },
      base: { repo: { full_name: "example/fixture", node_id: "repo-node" } },
    };
    const evidence = {
      repository: "example/fixture",
      runRequest: { tool: "factory_activate", arguments: { requestId: "activate-once" } },
      children: [
        { number: 2, state: "closed" },
        { number: 3, state: "open" },
        { number: 4, state: "open" },
      ],
      status: {
        workItems: [
          { number: 2, state: "done" },
          { number: 3, state: "running" },
          { number: 4, state: "blocked" },
        ],
      },
      pulls: [pull],
      mergeProofs: [
        {
          runId: "run",
          objective: 1,
          workItem: 2,
          attempt: 1,
          pullRequestNodeId: "pull-2",
          pullRequest: 2,
          repository: "example/fixture",
          repositoryNodeId: "repo-node",
          headSha: head("a"),
          mergeSha: head("1"),
        },
      ],
      nativeLinearIntervention: {
        case: "active-cancellation",
        requestId: "cancel-once",
        progress: {
          workItem: 3,
          attempt: 1,
          invalidationSequence: 21,
          invalidatedHeadSha: head("b"),
          invalidatedByItem: "root",
          invalidatedByHeadSha: head("1"),
          durableHeadSha: head("d"),
          validationSequence: 23,
          validationDigest: digest("d"),
          outputTreeSha: head("4"),
          reviewIdentityDigest: identityDigest,
          reviewUsageId: `rebase-review-${identityDigest}`,
          reviewUsageSequence: 24,
          attemptPublicationSequence: 25,
          artifactDigest: digest("9"),
          publicationSequence: 26,
          operationId: "linear-stack-operation",
          integratedWorkItem: 2,
          integrationSourceHeadSha: head("a"),
          integrationHeadSha: head("1"),
          integrationCompletedSequence: 19,
          attemptIntegratedSequence: 20,
        },
      },
      nativeLinearUnrelatedSentinel: {
        started: {
          status: "active",
          unit: "clockgrove-qualification-sentinel-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.service",
          invocationId: "1".repeat(32),
          controlGroupDigest: digest("a"),
        },
        survived: {
          status: "active",
          unit: "clockgrove-qualification-sentinel-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.service",
          invocationId: "1".repeat(32),
          controlGroupDigest: digest("a"),
        },
        stopped: { status: "absent" },
      },
    };
    expect(() => assertNativeCancellationBoundary(evidence, events)).not.toThrow();

    const completedDescendant = structuredClone(events);
    completedDescendant.push({
      event: "AttemptIntegrated",
      runId: "run",
      objective: 1,
      workItem: 3,
      attempt: 1,
      headSha: head("d"),
      sequence: 29,
    });
    expect(() => assertNativeCancellationBoundary(evidence, completedDescendant)).toThrow(
      /exactly the integrated root/,
    );

    const transplanted = structuredClone(evidence);
    transplanted.nativeLinearIntervention.progress.validationSequence = 999;
    expect(() => assertNativeCancellationBoundary(transplanted, events)).toThrow(
      /revalidation trigger/,
    );

    const missingMerge = structuredClone(evidence);
    missingMerge.mergeProofs = [];
    expect(() => assertNativeCancellationBoundary(missingMerge, events)).toThrow(/merge-proof/);

    const advanced = structuredClone(events);
    advanced.push({ event: "IntegrationCompleted", sequence: 31 });
    expect(() => assertNativeCancellationBoundary(evidence, advanced)).toThrow(
      /advanced after durable cancellation/,
    );
    for (const event of [
      "IntegrationPending",
      "RunPauseRequested",
      "RunResumeRequested",
      "RunDrainRequested",
      "CloudPauseRequested",
      "WorkItemRetryRequested",
      "RecoveryRequested",
      "ActivationCancellationRequested",
    ]) {
      const intervened = structuredClone(events);
      intervened.push({
        event,
        sequence: 31,
        kind: event.startsWith("Recovery") ? "recovery" : "run",
      });
      expect(() => assertNativeCancellationBoundary(evidence, intervened)).toThrow();
    }
    const extraActivation = structuredClone(events);
    extraActivation.push({ event: "ActivationRequested", requestId: "other", sequence: 1 });
    expect(() => assertNativeCancellationBoundary(evidence, extraActivation)).toThrow(
      /another activation/,
    );
    const resolvedDescendant = structuredClone(evidence);
    resolvedDescendant.children[1]!.state = "closed";
    expect(() => assertNativeCancellationBoundary(resolvedDescendant, events)).toThrow(
      /descendant issue is resolved/,
    );

    const replacedSentinel = structuredClone(evidence);
    replacedSentinel.nativeLinearUnrelatedSentinel.survived.invocationId = "2".repeat(32);
    expect(() => assertNativeCancellationBoundary(replacedSentinel, events)).toThrow(/sentinel/);
  });

  it("adopts one durable revalidated operation after a deliberately lost restart response", async () => {
    const input = controllerInput("response-loss-restart");
    await expect(executeNativeLinearControllerCase(input)).resolves.toEqual({
      objective: 7,
      runId: "run",
      status: "completed",
    });
    expect(input.call.mock.calls.map(([name]) => name)).toEqual([
      "factory_activate",
      "factory_controller_restart",
    ]);
    expect(input.evidence.nativeLinearIntervention).toMatchObject({
      case: "response-loss-restart",
      runId: "run",
      responseLost: true,
      progress: { workItem: 3, durableHeadSha: head("b") },
    });
  });

  it("requests active cancellation once after durable partial native progress", async () => {
    const input = controllerInput("active-cancellation");
    await expect(executeNativeLinearControllerCase(input)).resolves.toEqual({
      objective: 7,
      runId: "run",
      status: "cancelled",
    });
    expect(input.call.mock.calls.map(([name]) => name)).toEqual([
      "factory_activate",
      "factory_cancel",
    ]);
    expect(input.evidence.nativeLinearIntervention).toMatchObject({
      case: "active-cancellation",
      requested: true,
      responseLost: false,
    });
  });

  it("does not retry or relabel a run that becomes terminal before intervention", async () => {
    const input = controllerInput("response-loss-restart");
    input.observe = vi.fn(async () => ({
      events: [
        {
          event: "FactoryRunStarted",
          runId: "run",
          activationRequestId: input.runRequest.arguments.requestId,
        },
      ],
      status: { run: { availability: "observed", state: "completed" } },
    }));
    await expect(executeNativeLinearControllerCase(input)).resolves.toEqual({
      objective: 7,
      runId: "run",
      status: "completed",
    });
    expect(input.evidence).toMatchObject({
      nativeLinearEarlyTerminal: { runId: "run", status: "completed" },
    });
    expect(input.call).toHaveBeenCalledTimes(1);
    expect(input.call).toHaveBeenCalledWith("factory_activate", input.runRequest.arguments);
  });
});
