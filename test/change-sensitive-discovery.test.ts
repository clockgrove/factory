import { describe, expect, it } from "vitest";

import {
  DISCOVERY_SESSION_LIMITS,
  GitHubDiscoverySession,
  type DiscoveryClassification,
  type DiscoveryCollection,
  type DiscoveryComment,
  type DiscoveryControlRef,
  type DiscoveryIssue,
  type GitHubDiscoveryPorts,
} from "../src/control/discovery-session.js";
import { GitHubControlStore } from "../src/control/github-store.js";

const START = Date.parse("2026-01-01T00:00:00.000Z");

function issue(number: number, overrides: Partial<DiscoveryIssue> = {}): DiscoveryIssue {
  return {
    number,
    state: "closed",
    labels: ["factory:objective"],
    title: `Objective ${number}`,
    body: "fixture",
    pullRequest: false,
    updatedAt: "2025-12-01T00:00:00.000Z",
    ...overrides,
  };
}

function comment(
  objective: number,
  id = String(objective),
  overrides: Partial<DiscoveryComment> = {},
): DiscoveryComment {
  return {
    id,
    issueNumber: objective,
    body: "historical terminal receipt",
    authorLogin: "factory-controller",
    authorAssociation: "OWNER",
    updatedAt: "2025-12-01T00:00:00.000Z",
    ...overrides,
  };
}

function collection<T>(
  items: T[],
  options: Partial<Omit<DiscoveryCollection<T>, "items">> = {},
): DiscoveryCollection<T> {
  return { items, requests: 1, notModified: false, ...options };
}

function activation(objective: number) {
  return {
    objective,
    activatedAt: "2025-12-01T00:00:00.000Z",
    requestId: `request-${objective}`,
    policy: {},
    policyDigest: "c".repeat(64),
    baseSha: "a".repeat(40),
    requestedBy: "factory-controller",
  };
}

describe("GitHubDiscoverySession", () => {
  it.each([
    { objectiveCount: 1_000, labelledPageRequests: 10, discoveryRequests: 168 },
    { objectiveCount: 10_000, labelledPageRequests: 100, discoveryRequests: 528 },
  ])(
    "keeps a $objectiveCount-Objective history within its $discoveryRequests-request idle budget",
    async ({ objectiveCount, labelledPageRequests, discoveryRequests }) => {
      let now = START;
      const objectives = Array.from({ length: objectiveCount }, (_, index) => issue(index + 1));
      const calls = {
        authenticatedUser: 0,
        issues: 0,
        repositoryComments: 0,
        objectiveComments: 0,
        matchingRefs: 0,
        classifications: 0,
      };
      let labelled = 0;
      const ports: GitHubDiscoveryPorts = {
        authenticate: async () => {
          calls.authenticatedUser++;
          return { login: "factory-controller", serverTime: new Date(now) };
        },
        listLabelledIssues: async (_etag) => {
          calls.issues += labelledPageRequests;
          labelled++;
          return labelled === 1
            ? collection(objectives, { requests: labelledPageRequests })
            : collection(objectives, { requests: labelledPageRequests, notModified: false });
        },
        listIssueDelta: async (_since, etag) => {
          calls.issues++;
          return collection([], {
            notModified: Boolean(etag),
            etag: '"issue-delta"',
          });
        },
        listRepositoryComments: async (_since, etag) => {
          calls.repositoryComments++;
          return collection([], {
            notModified: Boolean(etag),
            etag: '"comment-delta"',
          });
        },
        listObjectiveComments: async (objective) => {
          // Model a two-page historical hydration. Warm discovery must never
          // repeat either page for unchanged terminal Objectives.
          calls.objectiveComments += 2;
          return collection([comment(objective)], { requests: 2 });
        },
        listControlRefs: async (etag) => {
          calls.matchingRefs++;
          return collection([], {
            notModified: Boolean(etag),
            etag: '"control-refs"',
          });
        },
        classify: async () => {
          calls.classifications++;
          return {
            activation: null,
            writerBound: false,
            authorityOid: null,
            recoveryBound: false,
          };
        },
      };
      const session = new GitHubDiscoverySession(ports, () => new Date(now));

      expect(await session.discover()).toEqual([]);
      const afterBootstrap = { ...calls };
      for (let cycle = 0; cycle < 60; cycle++) {
        now += 60_000;
        expect(await session.discover()).toEqual([]);
      }

      expect(calls.authenticatedUser - afterBootstrap.authenticatedUser).toBe(0);
      expect(calls.objectiveComments - afterBootstrap.objectiveComments).toBe(0);
      expect(calls.classifications - afterBootstrap.classifications).toBe(0);
      expect(
        calls.issues -
          afterBootstrap.issues +
          (calls.repositoryComments - afterBootstrap.repositoryComments) +
          (calls.matchingRefs - afterBootstrap.matchingRefs),
      ).toBe(discoveryRequests);
      expect(session.telemetry()).toMatchObject({
        cachedObjectives: objectiveCount,
        cachedComments: objectiveCount,
        droppedCycles: 0,
      });
      expect(
        session
          .telemetry()
          .cycles.filter((cycle) => cycle.mode === "delta")
          .reduce(
            (total, cycle) =>
              total +
              cycle.probes.issues +
              cycle.probes.repositoryComments +
              cycle.probes.objectiveComments +
              cycle.probes.matchingRefs,
            0,
          ),
      ).toBe(discoveryRequests);

      for (let cycle = 0; cycle < 10; cycle++) {
        now += 60_000;
        await session.discover();
      }
      expect(session.telemetry()).toMatchObject({
        cycles: expect.arrayContaining([
          expect.objectContaining({ mode: "delta", outcome: "complete" }),
        ]),
        droppedCycles: 7,
      });
      expect(session.telemetry().cycles).toHaveLength(DISCOVERY_SESSION_LIMITS.telemetryCycles);
    },
  );

  it("resumes a failed cold bootstrap without repeating completed Objectives", async () => {
    let authenticationCalls = 0;
    let labelledCalls = 0;
    const hydrated: number[] = [];
    const classified: number[] = [];
    let failSecond = true;
    const ports: GitHubDiscoveryPorts = {
      authenticate: async () => {
        authenticationCalls++;
        return { login: "factory-controller", serverTime: new Date(START) };
      },
      listLabelledIssues: async () => {
        labelledCalls++;
        return collection([issue(1), issue(2), issue(3)]);
      },
      listIssueDelta: async () => collection([]),
      listRepositoryComments: async () => collection([]),
      listObjectiveComments: async (objective) => {
        hydrated.push(objective);
        if (objective === 2 && failSecond) {
          failSecond = false;
          throw new Error("primary reserve reached during Objective #2");
        }
        return collection([comment(objective)]);
      },
      listControlRefs: async () => collection([]),
      classify: async ({ issue: candidate }) => {
        classified.push(candidate.number);
        return {
          activation: null,
          writerBound: false,
          authorityOid: null,
          recoveryBound: false,
        };
      },
    };
    const session = new GitHubDiscoverySession(ports, () => new Date(START));

    await expect(session.discover()).rejects.toThrow("primary reserve");
    expect(session.telemetry()).toMatchObject({ cachedObjectives: 1, cachedComments: 1 });
    expect(await session.discover()).toEqual([]);

    expect(authenticationCalls).toBe(1);
    expect(labelledCalls).toBe(1);
    expect(hydrated).toEqual([1, 2, 2, 3]);
    expect(classified).toEqual([1, 2, 3]);
  });

  it("resumes a 5,000-Objective warm delta across hydration and classification quota boundaries", async () => {
    let now = START;
    let deltaEnabled = false;
    let issueDeltaCalls = 0;
    let repositoryCommentCalls = 0;
    let failHydration = true;
    let failClassification = true;
    const hydrated: number[] = [];
    const classified: number[] = [];
    const additions = Array.from({ length: 5_000 }, (_, index) =>
      issue(index + 2, { updatedAt: "2026-01-01T00:01:00.000Z" }),
    );
    const ports: GitHubDiscoveryPorts = {
      authenticate: async () => ({ login: "factory-controller", serverTime: new Date(now) }),
      listLabelledIssues: async () => collection([issue(1)]),
      listIssueDelta: async () => {
        issueDeltaCalls++;
        return collection(deltaEnabled ? additions : []);
      },
      listRepositoryComments: async () => {
        repositoryCommentCalls++;
        return collection([]);
      },
      listObjectiveComments: async (objective) => {
        hydrated.push(objective);
        if (deltaEnabled && objective === 2_500 && failHydration) {
          failHydration = false;
          throw new Error("hydration primary reserve");
        }
        return collection([]);
      },
      listControlRefs: async () => collection([]),
      classify: async ({ issue: candidate }) => {
        classified.push(candidate.number);
        if (deltaEnabled && candidate.number === 4_000 && failClassification) {
          failClassification = false;
          throw new Error("classification primary reserve");
        }
        return {
          activation: null,
          writerBound: false,
          authorityOid: null,
          recoveryBound: false,
        };
      },
    };
    const session = new GitHubDiscoverySession(ports, () => new Date(now));
    await session.discover();
    hydrated.length = 0;
    classified.length = 0;
    deltaEnabled = true;
    now += 60_000;

    await expect(session.discover()).rejects.toThrow("hydration primary reserve");
    await expect(session.discover()).rejects.toThrow("classification primary reserve");
    await expect(session.discover()).resolves.toEqual([]);

    expect(issueDeltaCalls).toBe(1);
    expect(repositoryCommentCalls).toBe(1);
    expect(hydrated).toHaveLength(5_001);
    expect(hydrated.filter((number) => number === 2_500)).toHaveLength(2);
    expect(classified).toHaveLength(5_001);
    expect(classified.filter((number) => number === 4_000)).toHaveLength(2);
    expect(session.telemetry()).toMatchObject({ cachedObjectives: 5_001 });
  });

  it("rejects warm Objective growth before hydrating any new Objective", async () => {
    let deltaEnabled = false;
    let warmHydrations = 0;
    const session = new GitHubDiscoverySession({
      authenticate: async () => ({ login: "factory-controller", serverTime: new Date(START) }),
      listLabelledIssues: async () => collection([issue(1)]),
      listIssueDelta: async () =>
        collection(
          deltaEnabled
            ? Array.from({ length: DISCOVERY_SESSION_LIMITS.objectives }, (_, index) =>
                issue(index + 2),
              )
            : [],
        ),
      listRepositoryComments: async () => collection([]),
      listObjectiveComments: async () => {
        if (deltaEnabled) warmHydrations++;
        return collection([]);
      },
      listControlRefs: async () => collection([]),
      classify: async () => ({
        activation: null,
        writerBound: false,
        authorityOid: null,
        recoveryBound: false,
      }),
    });
    await session.discover();
    deltaEnabled = true;

    await expect(session.discover()).rejects.toThrow("10000-Objective discovery limit");
    expect(warmHydrations).toBe(0);
  });

  it("fails closed before classifying an over-limit Objective history", async () => {
    let classifications = 0;
    const session = new GitHubDiscoverySession({
      authenticate: async () => ({ login: "factory-controller", serverTime: new Date(START) }),
      listLabelledIssues: async () => collection([issue(1)]),
      listIssueDelta: async () => collection([]),
      listRepositoryComments: async () => collection([]),
      listObjectiveComments: async () =>
        collection(
          Array.from({ length: DISCOVERY_SESSION_LIMITS.commentsPerObjective + 1 }, (_, index) =>
            comment(1, String(index + 1)),
          ),
        ),
      listControlRefs: async () => collection([]),
      classify: async () => {
        classifications++;
        return {
          activation: null,
          writerBound: false,
          authorityOid: null,
          recoveryBound: false,
        };
      },
    });

    await expect(session.discover()).rejects.toThrow("exceeds the controller comment limit");
    expect(classifications).toBe(0);
  });

  it("advances revisions for same-timestamp issue/comment edits and recovery-ref movement", async () => {
    let now = START;
    let issueDelta: DiscoveryIssue[] = [];
    let commentDelta: DiscoveryComment[] = [];
    let refs: DiscoveryControlRef[] = [];
    const revisions: number[] = [];
    const firstIssue = issue(1, { state: "open", title: "first" });
    const firstComment = comment(1, "1", { body: "first" });
    const ports: GitHubDiscoveryPorts = {
      authenticate: async () => ({ login: "factory-controller", serverTime: new Date(now) }),
      listLabelledIssues: async (etag) =>
        etag
          ? collection([], { notModified: true, etag })
          : collection([firstIssue], { etag: '"labelled"' }),
      listIssueDelta: async () => collection(issueDelta),
      listRepositoryComments: async () => collection(commentDelta),
      listObjectiveComments: async () => collection([firstComment]),
      listControlRefs: async () => collection(refs, { etag: `"refs-${refs[0]?.oid ?? "none"}"` }),
      classify: async ({ issue: candidate, revision }) => {
        revisions.push(revision);
        return {
          activation: activation(candidate.number),
          writerBound: false,
          authorityOid: null,
          recoveryBound: true,
        };
      },
    };
    const session = new GitHubDiscoverySession(ports, () => new Date(now));

    expect((await session.discover())[0]?.discoveryRevision).toBe(1);
    issueDelta = [{ ...firstIssue, title: "edited at the same timestamp" }];
    now += 60_000;
    expect((await session.discover())[0]?.discoveryRevision).toBe(2);

    issueDelta = [];
    commentDelta = [{ ...firstComment, body: "edited at the same timestamp" }];
    now += 60_000;
    expect((await session.discover())[0]?.discoveryRevision).toBe(3);

    commentDelta = [];
    refs = [
      {
        kind: "recovery-plan",
        objective: 1,
        ref: `refs/clockgrove-factory/recovery-plans/objective-1/plan-${"a".repeat(64)}`,
        oid: "1".repeat(40),
        serverTime: new Date(now),
      },
    ];
    now += DISCOVERY_SESSION_LIMITS.backstopIntervalMs;
    expect((await session.discover())[0]?.discoveryRevision).toBe(4);
    refs = [{ ...refs[0]!, oid: "2".repeat(40), serverTime: new Date(now) }];
    now += DISCOVERY_SESSION_LIMITS.backstopIntervalMs;
    expect((await session.discover())[0]?.discoveryRevision).toBe(5);
    expect(revisions).toEqual([1, 2, 3, 4, 5]);
  });

  it("commits a changed cycle only after every classification succeeds", async () => {
    let failChangedClassification = true;
    const revisions: number[] = [];
    const original = issue(1, { state: "open", title: "original" });
    const changed = { ...original, title: "changed", updatedAt: "2026-01-01T00:01:00.000Z" };
    const ports: GitHubDiscoveryPorts = {
      authenticate: async () => ({ login: "factory-controller", serverTime: new Date(START) }),
      listLabelledIssues: async () => collection([original]),
      listIssueDelta: async () => collection([changed]),
      listRepositoryComments: async () => collection([]),
      listObjectiveComments: async () => collection([]),
      listControlRefs: async () => collection([]),
      classify: async ({ issue: candidate, revision }): Promise<DiscoveryClassification> => {
        revisions.push(revision);
        if (candidate.title === "changed" && failChangedClassification) {
          failChangedClassification = false;
          throw new Error("classification interrupted");
        }
        return {
          activation: activation(candidate.number),
          writerBound: false,
          authorityOid: null,
          recoveryBound: false,
        };
      },
    };
    let now = START;
    const session = new GitHubDiscoverySession(ports, () => new Date(now));

    expect((await session.discover())[0]?.discoveryRevision).toBe(1);
    now += 60_000;
    await expect(session.discover()).rejects.toThrow("classification interrupted");
    now += 60_000;
    expect((await session.discover())[0]?.discoveryRevision).toBe(2);
    expect(revisions).toEqual([1, 2, 2]);
  });

  it("records a failed backstop as a backstop", async () => {
    let now = START;
    let failRefs = false;
    const session = new GitHubDiscoverySession(
      {
        authenticate: async () => ({ login: "factory-controller", serverTime: new Date(now) }),
        listLabelledIssues: async () => collection([issue(1)]),
        listIssueDelta: async () => collection([]),
        listRepositoryComments: async () => collection([]),
        listObjectiveComments: async () => collection([]),
        listControlRefs: async () => {
          if (failRefs) throw new Error("control-ref probe failed");
          return collection([]);
        },
        classify: async () => ({
          activation: null,
          writerBound: false,
          authorityOid: null,
          recoveryBound: false,
        }),
      },
      () => new Date(now),
    );
    await session.discover();
    failRefs = true;
    now += DISCOVERY_SESSION_LIMITS.backstopIntervalMs;

    await expect(session.discover()).rejects.toThrow("control-ref probe failed");
    expect(session.telemetry().cycles.at(-1)).toMatchObject({
      mode: "delta",
      outcome: "failed",
      backstop: true,
    });
  });
});

describe("GitHubControlStore discovery adapter", () => {
  it("counts a transported page when response-record validation fails", async () => {
    const store = new GitHubControlStore({
      token: "discovery-response-validation-telemetry-test",
      owner: "clockgrove",
      repo: "factory",
      requestFetch: async (input) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.pathname === "/user")
          return new Response(JSON.stringify({ login: "factory-controller" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              date: new Date(START).toUTCString(),
            },
          });
        if (url.pathname.endsWith("/issues"))
          return new Response(
            JSON.stringify([
              {
                number: 0,
                state: "open",
                labels: [{ name: "factory:objective" }],
                title: "invalid",
                body: "fixture",
              },
            ]),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                date: new Date(START).toUTCString(),
              },
            },
          );
        throw new Error(`unexpected fixture request: ${url}`);
      },
    });

    await expect(store.discoverObjectiveActivations()).rejects.toThrow("invalid issue number");
    expect(store.discoveryTelemetry().cycles.at(-1)).toMatchObject({
      outcome: "failed",
      probes: { authenticatedUser: 1, issues: 1 },
    });
  });

  it("retains transported pages in failed-cycle telemetry", async () => {
    let issuePage = 0;
    const store = new GitHubControlStore({
      token: "discovery-partial-page-telemetry-test",
      owner: "clockgrove",
      repo: "factory",
      requestFetch: async (input) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.pathname === "/user")
          return new Response(JSON.stringify({ login: "factory-controller" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              date: new Date(START).toUTCString(),
            },
          });
        if (url.pathname.endsWith("/issues")) {
          issuePage++;
          if (issuePage === 2)
            return new Response(JSON.stringify({ message: "temporary" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          const next = new URL(url);
          next.searchParams.set("page", "2");
          return new Response(JSON.stringify([issue(1)]), {
            status: 200,
            headers: {
              "content-type": "application/json",
              date: new Date(START).toUTCString(),
              link: `<${next.toString()}>; rel="next"`,
            },
          });
        }
        throw new Error(`unexpected fixture request: ${url}`);
      },
    });

    await expect(store.discoverObjectiveActivations()).rejects.toThrow();
    expect(store.discoveryTelemetry().cycles.at(-1)).toMatchObject({
      outcome: "failed",
      probes: { issues: 2 },
    });
  });

  it("follows Link pagination without an unsafe page-one validator and reads all control refs once", async () => {
    let now = START;
    let warm = false;
    const requests: Array<{ url: URL; headers: Headers }> = [];
    const objective = (number: number) => ({
      number,
      state: "closed",
      labels: [{ name: "factory:objective" }],
      title: `Objective ${number}`,
      body: "fixture",
      updated_at: "2025-12-01T00:00:00.000Z",
    });
    const firstPage = [
      objective(1),
      ...Array.from({ length: 99 }, (_, index) => ({
        ...objective(index + 2),
        pull_request: { url: "https://api.github.com/pulls/fixture" },
      })),
    ];
    const response = (data: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          "content-type": "application/json",
          date: new Date(now).toUTCString(),
          ...headers,
        },
      });
    const requestFetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      requests.push({ url, headers });
      const path = decodeURIComponent(url.pathname);
      if (path === "/user") return response({ login: "factory-controller" });
      if (path.endsWith("/git/matching-refs/clockgrove-factory/")) {
        return response(
          [
            {
              ref: "refs/clockgrove-factory/leases/objective-1",
              object: { sha: "1".repeat(40) },
            },
            {
              ref: `refs/clockgrove-factory/recovery-plans/objective-1/plan-${"a".repeat(64)}`,
              object: { sha: "2".repeat(40) },
            },
          ],
          { etag: '"control-refs"' },
        );
      }
      if (/\/issues\/\d+\/comments$/.test(path)) return response([]);
      if (path.endsWith("/issues/comments")) return response([], { etag: '"comments"' });
      if (path.endsWith("/issues")) {
        const page = Number(url.searchParams.get("page") ?? "1");
        const labelled = url.searchParams.has("labels");
        if (!labelled) return response([], { etag: '"issue-delta"' });
        if (page === 2) return response(warm ? [objective(101)] : []);
        const next = new URL(url);
        next.searchParams.set("page", "2");
        return response(firstPage, {
          etag: '"unchanged-page-one"',
          link: `<${next.toString()}>; rel="next"`,
        });
      }
      throw new Error(`unexpected fixture request: ${url}`);
    };
    const store = new GitHubControlStore({
      token: "discovery-adapter-pagination-test",
      owner: "clockgrove",
      repo: "factory",
      requestFetch,
      discoveryNow: () => new Date(now),
    });

    expect(await store.discoverObjectiveActivations()).toEqual([]);
    expect(store.discoveryTelemetry()).toMatchObject({ cachedObjectives: 1 });
    warm = true;
    now += DISCOVERY_SESSION_LIMITS.backstopIntervalMs;
    expect(await store.discoverObjectiveActivations()).toEqual([]);
    expect(store.discoveryTelemetry()).toMatchObject({ cachedObjectives: 2 });

    const warmLabelled = requests.filter(
      ({ url }) => warm && url.pathname.endsWith("/issues") && url.searchParams.has("labels"),
    );
    // Both bootstrap and warm requests are retained in `requests`; the final
    // two are the warm page pair. A multi-page collection never supplied a
    // page-one ETag to the backstop.
    expect(warmLabelled.slice(-2)).toHaveLength(2);
    expect(warmLabelled.slice(-2).map(({ headers }) => headers.get("if-none-match"))).toEqual([
      null,
      null,
    ]);
    const matchingRefs = requests.filter(({ url }) =>
      decodeURIComponent(url.pathname).endsWith("/git/matching-refs/clockgrove-factory/"),
    );
    expect(matchingRefs).toHaveLength(1);
    expect([...matchingRefs[0]!.url.searchParams.keys()]).toEqual([]);
  });

  it("uses immutable creation order so an inter-page edit cannot skip an older delta row", async () => {
    let now = START;
    let bootstrap = true;
    let deltaPage = 0;
    const rawIssue = (number: number, title: string, updatedAt: string) => ({
      number,
      state: "closed",
      labels: [{ name: "factory:objective" }],
      title,
      body: "fixture",
      created_at: `2025-01-${String(number).padStart(2, "0")}T00:00:00.000Z`,
      updated_at: updatedAt,
    });
    const response = (data: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          "content-type": "application/json",
          date: new Date(now).toUTCString(),
          ...headers,
        },
      });
    const store = new GitHubControlStore({
      token: "discovery-immutable-pagination-test",
      owner: "clockgrove",
      repo: "factory",
      discoveryNow: () => new Date(now),
      requestFetch: async (input) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        const path = decodeURIComponent(url.pathname);
        if (path === "/user") return response({ login: "factory-controller" });
        if (/\/issues\/\d+\/comments$/.test(path)) return response([]);
        if (path.endsWith("/issues/comments")) return response([]);
        if (!path.endsWith("/issues")) throw new Error(`unexpected fixture request: ${url}`);
        if (url.searchParams.has("labels")) {
          return response(
            bootstrap
              ? [
                  rawIssue(1, "old one", "2025-12-01T00:00:00.000Z"),
                  rawIssue(2, "old two", "2025-12-01T00:00:00.000Z"),
                ]
              : [],
          );
        }
        expect(url.searchParams.get("sort")).toBe("created");
        const page = Number(url.searchParams.get("page") ?? "1");
        deltaPage++;
        if (page === 1) {
          const next = new URL(url);
          next.searchParams.set("page", "2");
          return response([rawIssue(1, "changed one", "2026-01-01T00:00:01.000Z")], {
            link: `<${next.toString()}>; rel="next"`,
          });
        }
        // Issue #1 is edited again between requests. In mutable updated_at
        // order it would move behind #2 and page 2 would repeat #1, skipping #2.
        return response([rawIssue(2, "changed two", "2026-01-01T00:00:01.000Z")]);
      },
    });

    await store.discoverObjectiveActivations();
    bootstrap = false;
    now += 60_000;
    await store.discoverObjectiveActivations();

    expect(deltaPage).toBe(2);
    expect(store.discoveryTelemetry().cycles.at(-1)).toMatchObject({
      outcome: "complete",
      dirtyObjectives: 2,
      probes: { issues: 2 },
    });
  });
});
