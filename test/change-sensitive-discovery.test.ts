import { describe, expect, it } from "vitest";

import {
  DISCOVERY_SESSION_LIMITS,
  GitHubDiscoverySession,
  recordPartialDiscoveryRequests,
  type DiscoveryClassification,
  type DiscoveryCollection,
  type DiscoveryComment,
  type DiscoveryIssue,
  type DiscoveryLocator,
  type DiscoveryPage,
  type GitHubDiscoveryPorts,
} from "../src/control/discovery-session.js";

const START = Date.parse("2026-09-13T00:00:00.000Z");
const OLD = "2024-01-01T00:00:00.000Z";
const iso = (value: number) => new Date(value).toISOString();

function issue(number: number, overrides: Partial<DiscoveryIssue> = {}): DiscoveryIssue {
  return { number, state: "open", objectiveLabel: true, updatedAt: OLD, comments: 3, ...overrides };
}

function comment(objective: number, body: string, id = String(objective)): DiscoveryComment {
  return {
    id,
    issueNumber: objective,
    body,
    authorLogin: "factory-controller",
    authorAssociation: "OWNER",
    updatedAt: OLD,
  };
}

function collection<T>(
  items: T[],
  options: Partial<DiscoveryCollection<T>> = {},
): DiscoveryCollection<T> {
  return {
    items,
    requests: 1,
    notModified: false,
    returnedBytes: Buffer.byteLength(JSON.stringify(items)),
    ...options,
  };
}

function page<T>(
  items: T[],
  cursor: string | null = null,
  serverTime = iso(START),
): DiscoveryPage<T> {
  return {
    items,
    cursor,
    serverTime,
    requests: 1,
    returnedBytes: Buffer.byteLength(JSON.stringify(items)),
  };
}

function activation(objective: number) {
  return {
    objective,
    activatedAt: OLD,
    requestId: `request-${objective}`,
    policy: {},
    policyDigest: "c".repeat(64),
    baseSha: "a".repeat(40),
    requestedBy: "factory-controller",
  };
}

function classified(objective?: number): DiscoveryClassification {
  return {
    activation: objective ? activation(objective) : null,
    writerBound: false,
    authorityOid: null,
    recoveryBound: false,
  };
}

function locator(objective: number): DiscoveryLocator {
  return {
    objective,
    ref: `refs/clockgrove-factory/active/objective-${objective}/request-fixture`,
    oid: "a".repeat(40),
  };
}

/** The provider owns historical data. Enumeration implements server-side label,
 * state, and time filters; comments are generated only on an exact history read.
 * Classification is injected: these tests measure discovery, not event authority. */
function repository(
  rows: DiscoveryIssue[],
  active: ReadonlySet<number> = new Set(),
  commentBodyBytes = 0,
) {
  let now = START;
  let locators: DiscoveryLocator[] = [];
  const enumerations: Array<Parameters<GitHubDiscoveryPorts["listIssues"]>[0]> = [];
  const hydrated: number[] = [];
  const exact: Array<{ objective: number; etag: string | undefined }> = [];
  const classifications: Array<{ objective: number; revision: number; comments: number }> = [];
  const ports: GitHubDiscoveryPorts = {
    authenticate: async () => ({ login: "Factory-Controller", serverTime: new Date(now) }),
    listIssues: async (input) => {
      enumerations.push({ ...input });
      const selected = rows.filter(
        (row) =>
          row.objectiveLabel &&
          row.state === input.state &&
          (!input.since || Date.parse(row.updatedAt) >= Date.parse(input.since)),
      );
      const offset = Number(input.cursor ?? 0);
      const end = offset + DISCOVERY_SESSION_LIMITS.pageSize;
      return page(
        selected.slice(offset, end).map((row) => ({ ...row })),
        end < selected.length ? String(end) : null,
        iso(now),
      );
    },
    listLocators: async (cursor) => {
      const offset = Number(cursor ?? 0);
      const end = offset + DISCOVERY_SESSION_LIMITS.pageSize;
      return page(
        locators.slice(offset, end),
        end < locators.length ? String(end) : null,
        iso(now),
      );
    },
    readIssue: async (objective, etag) => {
      exact.push({ objective, etag });
      return collection(
        rows.filter((row) => row.number === objective).map((row) => ({ ...row })),
        { etag: `"issue-${objective}"` },
      );
    },
    listObjectiveComments: async (objective) => {
      hydrated.push(objective);
      const row = rows.find((candidate) => candidate.number === objective)!;
      const entries = Array.from({ length: row.comments }, (_, index) => {
        const summary =
          index === 0 && active.has(objective)
            ? "authenticated activation request"
            : row.state === "closed"
              ? "settled run, exact accounting and cleanup receipt"
              : "planning discussion; no activation authority";
        const details = `\n\nWork item ${index + 1}: review the expected behavior, dependency evidence, validation results and remaining acceptance criteria. The recorded observation includes the candidate revision, ownership and the next concrete action. `;
        const body = commentBodyBytes
          ? (summary + details.repeat(Math.ceil(commentBodyBytes / details.length))).slice(
              0,
              commentBodyBytes,
            )
          : summary;
        return comment(objective, body, `${objective}-${index}`);
      });
      return collection(entries, { requests: Math.ceil(row.comments / 100) });
    },
    classify: async ({ issue: candidate, comments, revision, login }) => {
      expect(login).toBe("factory-controller");
      classifications.push({ objective: candidate.number, revision, comments: comments.length });
      return classified(
        comments.some((entry) => entry.body.startsWith("authenticated activation request"))
          ? candidate.number
          : undefined,
      );
    },
  };
  return {
    ports,
    rows,
    hydrated,
    exact,
    classifications,
    enumerations,
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
    setLocators: (value: DiscoveryLocator[]) => {
      locators = value;
    },
  };
}

async function finishScan(session: GitHubDiscoverySession, maximum = 100) {
  for (let count = 0; count < maximum; count++) {
    await session.discover();
    if (session.telemetry().incompleteScans === 0) return;
  }
  throw new Error("synthetic discovery did not finish its bounded scan");
}

function measurement(session: GitHubDiscoverySession, fullScan = false) {
  const telemetry = session.telemetry();
  const cycles = fullScan ? telemetry.cycles : telemetry.cycles.slice(-1);
  return {
    cycles: cycles.length,
    requests: cycles.reduce(
      (total, { probes }) =>
        total +
        probes.authenticatedUser +
        probes.issues +
        probes.objectiveComments +
        probes.matchingRefs,
      0,
    ),
    bytes: cycles.reduce((total, cycle) => total + (cycle.returnedBytes ?? 0), 0),
    commentRequests: cycles.reduce((total, { probes }) => total + probes.objectiveComments, 0),
    classifications: cycles.reduce((total, { probes }) => total + probes.classifications, 0),
    retained: telemetry.cachedObjectives,
    retainedComments: telemetry.cachedComments,
    retainedBytes: telemetry.retainedSummaryBytes,
  };
}

describe("bounded active discovery", () => {
  it("keeps cold and warm cost identical for five active Objectives behind 100 or 100,000 settled histories", async () => {
    const evidence = [];
    for (const settledCount of [100, 100_000]) {
      const rows = [
        ...Array.from({ length: 5 }, (_, index) => issue(index + 1, { comments: 240 })),
        ...Array.from({ length: settledCount }, (_, index) =>
          issue(index + 6, { state: "closed", comments: 400 }),
        ),
      ];
      const fixture = repository(rows, new Set([1, 2, 3, 4, 5]), 1_536);
      const session = new GitHubDiscoverySession(fixture.ports, fixture.now);
      expect((await session.discover()).map((entry) => entry.objective)).toEqual([1, 2, 3, 4, 5]);
      const cold = measurement(session);
      fixture.advance(60_000);
      expect(await session.discover()).toHaveLength(5);
      const warm = measurement(session);
      expect(fixture.hydrated).toEqual([1, 2, 3, 4, 5]);
      expect(fixture.enumerations[0]).toEqual({ state: "open" });
      expect(fixture.enumerations.find((entry) => entry.state === "closed")?.since).toBe(
        iso(START - DISCOVERY_SESSION_LIMITS.closedLookbackMs - DISCOVERY_SESSION_LIMITS.overlapMs),
      );
      expect(cold).toMatchObject({
        requests: 19,
        commentRequests: 15,
        classifications: 5,
        retained: 5,
        retainedComments: 0,
      });
      expect(warm).toMatchObject({
        requests: 8,
        commentRequests: 0,
        classifications: 0,
        retained: 5,
        retainedComments: 0,
      });
      expect(cold.bytes).toBeGreaterThan(0);
      expect(warm.bytes).toBeLessThan(cold.bytes!);
      evidence.push({ cold: { ...cold, historiesRead: 5 }, warm: { ...warm, historiesRead: 0 } });
    }
    expect(evidence[1]).toEqual(evidence[0]);
  });

  it("measures a bounded cold scan and warm polling with 200 realistic open inactive histories", async () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, index) => issue(index + 1, { comments: 240 })),
      ...Array.from({ length: 200 }, (_, index) => issue(index + 6, { comments: 120 })),
      ...Array.from({ length: 100_000 }, (_, index) =>
        issue(index + 206, { state: "closed", comments: 400 }),
      ),
    ];
    const fixture = repository(rows, new Set([1, 2, 3, 4, 5]), 1_536);
    const session = new GitHubDiscoverySession(fixture.ports, fixture.now);
    await finishScan(session);
    const cold = { ...measurement(session, true), historiesRead: fixture.hydrated.length };
    expect(cold).toMatchObject({
      cycles: 9,
      commentRequests: 415,
      classifications: 205,
      historiesRead: 205,
      retained: 205,
      retainedComments: 0,
    });
    expect(fixture.hydrated).toEqual(Array.from({ length: 205 }, (_, index) => index + 1));
    expect(
      session
        .telemetry()
        .cycles.every(
          (cycle) => cycle.probes.classifications <= DISCOVERY_SESSION_LIMITS.candidatesPerLane,
        ),
    ).toBe(true);
    expect(cold.retainedBytes).toBeLessThan(DISCOVERY_SESSION_LIMITS.summaryBytes);
    fixture.advance(60_000);
    await finishScan(session);
    const warm = {
      ...measurement(session),
      historiesRead: fixture.hydrated.length - cold.historiesRead,
    };
    expect(warm).toMatchObject({
      cycles: 1,
      requests: 8,
      commentRequests: 0,
      classifications: 0,
      historiesRead: 0,
      retained: 205,
      retainedComments: 0,
    });
    expect(warm.bytes).toBeLessThan(cold.bytes / 1_000);
  });

  it("reads nonempty open inactive histories instead of treating them as cheaply proven absence", async () => {
    const fixture = repository(
      Array.from({ length: 40 }, (_, index) => issue(index + 1, { comments: 8 })),
    );
    const session = new GitHubDiscoverySession(fixture.ports, fixture.now);
    expect(await session.discover()).toEqual([]);
    expect(fixture.hydrated).toHaveLength(DISCOVERY_SESSION_LIMITS.candidatesPerLane);
    await finishScan(session);
    expect(fixture.hydrated).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    expect(fixture.classifications.every((entry) => entry.comments === 8)).toBe(true);
    expect(session.telemetry()).toMatchObject({ cachedComments: 0, cachedObjectives: 40 });
  });

  it("discovers an old open request on cold start after arbitrarily long downtime", async () => {
    const fixture = repository([issue(7, { updatedAt: "2009-01-01T00:00:00.000Z" })], new Set([7]));
    const session = new GitHubDiscoverySession(fixture.ports, fixture.now);
    expect(await session.discover()).toMatchObject([{ objective: 7 }]);
    expect(fixture.enumerations[0]).not.toHaveProperty("since");
  });

  it("drops settled closed summaries while exact locators still inspect old unlabelled closed obligations", async () => {
    const fixture = repository([
      issue(1, { state: "closed", updatedAt: iso(START) }),
      issue(2, { state: "closed", objectiveLabel: false }),
    ]);
    const session = new GitHubDiscoverySession(fixture.ports, fixture.now);
    expect(await session.discover()).toEqual([]);
    expect(session.telemetry().cachedObjectives).toBe(0);
    fixture.advance(
      DISCOVERY_SESSION_LIMITS.closedLookbackMs + DISCOVERY_SESSION_LIMITS.overlapMs + 1,
    );
    fixture.setLocators([locator(2)]);
    expect(await session.discover()).toEqual([]);
    expect(fixture.exact.map((entry) => entry.objective)).toEqual([2]);
    expect(fixture.hydrated).toEqual([1, 2]);
    // An unresolved locator is inspection scope; it creates no activation.
    expect(fixture.classifications.find((entry) => entry.objective === 2)).toBeDefined();
  });

  it("continues bounded pages without replaying completed rows or advancing a partial scan watermark", async () => {
    const fixture = repository(
      Array.from({ length: 105 }, (_, index) => issue(index + 1, { comments: 1 })),
      new Set([1, 105]),
    );
    const session = new GitHubDiscoverySession(fixture.ports, fixture.now);
    expect(await session.discover()).toMatchObject([{ objective: 1 }]);
    expect(fixture.hydrated).toHaveLength(32);
    expect(session.telemetry()).toMatchObject({ incompleteScans: 1 });
    fixture.advance(60_000);
    await finishScan(session);
    expect(fixture.hydrated).toHaveLength(105);
    expect(new Set(fixture.hydrated).size).toBe(105);
    expect(fixture.enumerations.filter((entry) => entry.state === "open")).toEqual([
      { state: "open" },
      { state: "open", cursor: "100" },
    ]);
    await session.discover();
    expect(fixture.enumerations.filter((entry) => entry.state === "open").at(-1)).toEqual({
      state: "open",
      since: iso(START - DISCOVERY_SESSION_LIMITS.overlapMs),
    });
    expect(await session.discover()).toMatchObject([{ objective: 1 }, { objective: 105 }]);
  });

  it("resumes a failed later page and preserves its initial server-time watermark", async () => {
    const fixture = repository(
      Array.from({ length: 101 }, (_, index) => issue(index + 1, { comments: 0 })),
    );
    const list = fixture.ports.listIssues;
    const attempted: Array<Parameters<GitHubDiscoveryPorts["listIssues"]>[0]> = [];
    let fail = true;
    fixture.ports.listIssues = async (input) => {
      attempted.push(input);
      if (input.state === "open" && input.cursor && fail) {
        fail = false;
        const error = new Error("temporary second-page failure");
        recordPartialDiscoveryRequests(error, 1);
        throw error;
      }
      return list(input);
    };
    const session = new GitHubDiscoverySession(fixture.ports, fixture.now);
    for (let index = 0; index < 4; index++) await session.discover();
    fixture.advance(60_000);
    await expect(session.discover()).rejects.toThrow("temporary second-page failure");
    expect(session.telemetry().cycles.at(-1)).toMatchObject({
      outcome: "failed",
      probes: { issues: 1 },
    });
    await session.discover();
    await session.discover();
    expect(attempted.filter((entry) => entry.state === "open")).toEqual([
      { state: "open" },
      { state: "open", cursor: "100" },
      { state: "open", cursor: "100" },
      { state: "open", since: iso(START - DISCOVERY_SESSION_LIMITS.overlapMs) },
    ]);
    expect(fixture.classifications).toHaveLength(101);
  });

  it("retries the interrupted candidate after platform quota without replaying classified siblings", async () => {
    const fixture = repository([issue(1), issue(2), issue(3)], new Set([1, 2, 3]));
    const classify = fixture.ports.classify;
    const attempts: number[] = [];
    let fail = true;
    fixture.ports.classify = async (input) => {
      attempts.push(input.issue.number);
      if (input.issue.number === 2 && fail) {
        fail = false;
        const error = new Error("primary quota exhausted");
        error.name = "PlatformUnavailableError";
        throw error;
      }
      return classify(input);
    };
    const session = new GitHubDiscoverySession(fixture.ports, fixture.now);
    await expect(session.discover()).rejects.toThrow("primary quota exhausted");
    fixture.advance(60_000);
    expect((await session.discover()).map((entry) => entry.objective)).toEqual([1, 2, 3]);
    expect(attempts).toEqual([1, 2, 2, 3]);
    expect(fixture.enumerations.filter((entry) => entry.state === "open")).toHaveLength(1);
    await session.discover();
    expect(fixture.enumerations.filter((entry) => entry.state === "open").at(-1)?.since).toBe(
      iso(START - DISCOVERY_SESSION_LIMITS.overlapMs),
    );
  });

  it("isolates malformed histories and transient history bounds from independent Objectives", async () => {
    const fixture = repository([issue(1), issue(2), issue(3)], new Set([3]));
    const classify = fixture.ports.classify;
    const comments = fixture.ports.listObjectiveComments;
    fixture.ports.listObjectiveComments = async (objective) =>
      objective === 2
        ? collection(
            Array.from({ length: DISCOVERY_SESSION_LIMITS.commentsPerObjective + 1 }, (_, index) =>
              comment(2, "old receipt", String(index)),
            ),
          )
        : comments(objective);
    fixture.ports.classify = async (input) => {
      if (input.issue.number === 1) throw new Error("malformed authenticated event");
      return classify(input);
    };
    const session = new GitHubDiscoverySession(fixture.ports, fixture.now);
    expect(await session.discover()).toMatchObject([{ objective: 3 }]);
    expect(session.telemetry()).toMatchObject({
      cachedComments: 0,
      objectiveErrors: [
        { objective: 1, reason: "malformed authenticated event" },
        { objective: 2, reason: "Objective #2 exceeds its transient history bound" },
      ],
    });
    expect(fixture.classifications.map((entry) => entry.objective)).toEqual([3]);
  });

  it("caps disposable summary memory across a large open inactive scan", async () => {
    const count = DISCOVERY_SESSION_LIMITS.summaries * 3;
    const fixture = repository(
      Array.from({ length: count }, (_, index) => issue(index + 1, { comments: 1 })),
    );
    const session = new GitHubDiscoverySession(fixture.ports, fixture.now);
    await finishScan(session);
    expect(fixture.hydrated).toHaveLength(count);
    expect(session.telemetry()).toMatchObject({
      cachedObjectives: DISCOVERY_SESSION_LIMITS.summaries,
      cachedComments: 0,
      evictedSummaries: count - DISCOVERY_SESSION_LIMITS.summaries,
    });
    expect(session.telemetry().retainedSummaryBytes).toBeLessThanOrEqual(
      DISCOVERY_SESSION_LIMITS.summaryBytes,
    );
    expect(
      session
        .telemetry()
        .cycles.every(
          (cycle) => cycle.probes.classifications <= DISCOVERY_SESSION_LIMITS.candidatesPerLane,
        ),
    ).toBe(true);
  });

  it("uses an exact issue 304 only with a previously observed issue", async () => {
    const fixture = repository([issue(1)], new Set([1]));
    fixture.setLocators([locator(1)]);
    const original = fixture.ports.readIssue;
    let reads = 0;
    fixture.ports.readIssue = async (objective, etag) => {
      reads++;
      return reads === 1
        ? original(objective, etag)
        : collection([], { notModified: true, ...(etag ? { etag } : {}) });
    };
    const session = new GitHubDiscoverySession(fixture.ports, fixture.now);
    await session.discover();
    await session.discover([1]);
    expect(await session.discover([1])).toMatchObject([{ objective: 1 }]);
    expect(fixture.exact).toEqual([{ objective: 1, etag: undefined }]);
    expect(session.telemetry().cycles.at(-1)?.probes.notModified).toBe(1);
    const cold = repository([]);
    cold.setLocators([locator(99)]);
    cold.ports.readIssue = async () => collection([], { notModified: true });
    const coldSession = new GitHubDiscoverySession(cold.ports, cold.now);
    expect(await coldSession.discover()).toEqual([]);
    expect(coldSession.telemetry().objectiveErrors).toEqual([
      { objective: 99, reason: "exact Objective #99 is unavailable; absence is unproven" },
    ]);
    expect(cold.classifications).toEqual([]);
  });

  it("rehydrates metadata/comment changes and periodically rechecks same-timestamp edits without keeping comments", async () => {
    const fixture = repository([issue(1, { updatedAt: iso(START) })], new Set([1]));
    const session = new GitHubDiscoverySession(fixture.ports, fixture.now);
    const first = (await session.discover())[0]!.discoveryRevision!;
    fixture.rows[0]!.comments++;
    fixture.advance(1_000);
    const second = (await session.discover())[0]!.discoveryRevision!;
    expect(second).toBeGreaterThan(first);
    fixture.rows[0]!.objectiveLabel = false;
    const third = (await session.discover([1]))[0]!.discoveryRevision!;
    expect(third).toBeGreaterThan(second);
    fixture.advance(DISCOVERY_SESSION_LIMITS.backstopIntervalMs);
    const fourth = (await session.discover([1]))[0]!.discoveryRevision!;
    expect(fourth).toBeGreaterThan(third);
    expect(fixture.hydrated).toEqual([1, 1, 1, 1]);
    expect(session.telemetry().cachedComments).toBe(0);
  });

  it("does not infer absence of already-known work from an incomplete filtered backstop", async () => {
    const fixture = repository([issue(900)], new Set([900]));
    const session = new GitHubDiscoverySession(fixture.ports, fixture.now);
    await session.discover();
    fixture.rows.unshift(
      ...Array.from({ length: 100 }, (_, index) => issue(index + 1, { comments: 0 })),
    );
    fixture.advance(DISCOVERY_SESSION_LIMITS.backstopIntervalMs);
    expect(await session.discover()).toMatchObject([{ objective: 900 }]);
    expect(session.telemetry().incompleteScans).toBe(1);
    expect(fixture.exact.at(-1)?.objective).toBe(900);
  });
  it("rechecks inactive history after metadata changes and same-timestamp edits at the backstop", async () => {
    const active = new Set<number>();
    const fixture = repository([issue(1, { updatedAt: iso(START) })], active);
    const session = new GitHubDiscoverySession(fixture.ports, fixture.now);
    expect(await session.discover()).toEqual([]);
    fixture.rows[0]!.comments++;
    fixture.advance(1_000);
    expect(await session.discover()).toEqual([]);
    expect(fixture.classifications).toHaveLength(2);
    // Body edits with no changed metadata are bounded by the full backstop.
    active.add(1);
    fixture.advance(DISCOVERY_SESSION_LIMITS.backstopIntervalMs);
    expect(await session.discover()).toMatchObject([{ objective: 1 }]);
    expect(fixture.classifications).toHaveLength(3);
    fixture.rows[0]!.objectiveLabel = false;
    expect(await session.discover([1])).toMatchObject([{ objective: 1 }]);
    expect(fixture.classifications).toHaveLength(4);
    expect(session.telemetry().cachedComments).toBe(0);
  });

  it("enforces the byte bound before the summary-count bound", async () => {
    const fixture = repository(
      Array.from({ length: 12 }, (_, index) => issue(index + 1, { comments: 0 })),
    );
    fixture.ports.classify = async ({ issue: candidate }) => ({
      ...classified(),
      activation: { ...activation(candidate.number), policy: { fixture: "x".repeat(512 * 1024) } },
    });
    const session = new GitHubDiscoverySession(fixture.ports, fixture.now);
    await session.discover();
    expect(session.telemetry().cachedObjectives).toBeLessThan(12);
    expect(session.telemetry().retainedSummaryBytes).toBeLessThanOrEqual(
      DISCOVERY_SESSION_LIMITS.summaryBytes,
    );
    expect(session.telemetry().evictedSummaries).toBeGreaterThan(0);
  });

  it("does not accept a previously rejected malformed page on the next attempt", async () => {
    const fixture = repository([]);
    let reads = 0;
    fixture.ports.listIssues = async ({ state }) => {
      if (state === "closed") return page([]);
      reads++;
      return page(
        Array.from({ length: DISCOVERY_SESSION_LIMITS.pageSize + 1 }, (_, index) =>
          issue(index + 1, { comments: 0 }),
        ),
      );
    };
    const session = new GitHubDiscoverySession(fixture.ports, fixture.now);
    await expect(session.discover()).rejects.toThrow("invalid bounded discovery page/cursor");
    await expect(session.discover()).rejects.toThrow("invalid bounded discovery page/cursor");
    expect(reads).toBe(2);
    expect(fixture.classifications).toEqual([]);
    expect(session.telemetry().cachedObjectives).toBe(0);
  });
});
