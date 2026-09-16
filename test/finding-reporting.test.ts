import { describe, expect, it } from "vitest";

import {
  FindingReporter,
  classifyFinding,
  decideFindingAtSupervisor,
  type FindingIssueObservation,
  type FindingJournal,
  type FindingRecord,
  type FindingReportingPort,
} from "../src/control/finding-reporting.js";
import {
  FINDING_PROTOCOL,
  findingIdentity,
  findingReportDigest,
  renderFindingIssue,
  validateFindingCandidate,
  type FindingCandidate,
  type FindingReportingPolicy,
} from "../src/protocol/findings.js";
import { parseFactoryEvent, type FindingEvent } from "../src/protocol/events.js";
import { buildStatusReport } from "../src/application/status.js";
import { buildExplanationReport } from "../src/application/explain.js";
import { artifactDigest, normalizeArtifact, verifyArtifact } from "../src/execution/artifacts.js";

const sha = (character: string) => character.repeat(64);
const candidate = (artifact = sha("a")): FindingCandidate => ({
  protocol: FINDING_PROTOCOL,
  phase: "validation",
  failureClass: "unexpected-output",
  supportedBehavior: "The formatter preserves fenced Markdown attachments.",
  observedBehavior: "A fenced attachment is removed from the rendered output.",
  reproduction: ["Render fixture docs/attachment.md", "Compare the fenced attachment"],
  impact: "The attachment cannot be recovered from the generated report.",
  possibleCause: "The media dispatch may treat unknown text as an image.",
  evidence: [{ kind: "artifact", digest: artifact, commit: "b".repeat(40) }],
});
const occurrence = { objective: 382, workItem: 901, runId: "run-382", attempt: 1 } as const;
const policy: FindingReportingPolicy = {
  destinations: [
    {
      repository: "clockgrove/factory",
      audience: "public",
      operations: ["read", "create-issue"],
    },
  ],
  maxPublicationWrites: 2,
};

class Journal implements FindingJournal {
  readonly records: FindingRecord[] = [];
  readonly events: FindingEvent[] = [];

  constructor(readonly runId = "run-382") {}

  async read() {
    return this.events;
  }

  async append(record: FindingRecord) {
    this.records.push(structuredClone(record));
    this.events.push(
      parseFactoryEvent({
        protocol: "clockgrove.factory/v2",
        kind: "finding",
        objective: 382,
        runId: this.runId,
        sequence: this.events.length + 1,
        at: new Date(this.events.length * 1_000).toISOString(),
        ...record,
      }) as FindingEvent,
    );
  }
}

function issue(body: string, number = 700): FindingIssueObservation {
  return {
    repository: "clockgrove/factory",
    number,
    nodeId: `I_${number}`,
    url: `https://github.com/clockgrove/factory/issues/${number}`,
    state: "open",
    author: "factory-bot",
    body,
  };
}

function port(overrides: Partial<FindingReportingPort> = {}) {
  const created: Array<{ title: string; body: string }> = [];
  const comments: Array<{ issueNumber: number; body: string }> = [];
  const value: FindingReportingPort & { created: typeof created; comments: typeof comments } = {
    created,
    comments,
    async authenticatedLogin() {
      return "factory-bot";
    },
    async probe(destination) {
      return {
        repository: destination.repository,
        audience: destination.audience,
        issuesEnabled: true,
        canCreateIssue: true,
        blankIssuesEnabled: true,
      };
    },
    async findByMarker() {
      return [];
    },
    async createIssue(input) {
      created.push({ title: input.title, body: input.body });
      return issue(input.body);
    },
    async findEvidenceComments() {
      return [];
    },
    async commentEvidence(input) {
      comments.push({ issueNumber: input.issueNumber, body: input.body });
      return { id: String(comments.length), author: "factory-bot", body: input.body };
    },
    ...overrides,
  };
  return value;
}

describe("finding protocol", () => {
  it("uses destination and immutable artifact evidence, but not occurrence IDs, for identity", () => {
    const first = findingIdentity("clockgrove/factory", candidate());
    expect(first).toHaveLength(64);
    expect(findingIdentity("clockgrove/factory", candidate())).toBe(first);
    expect(findingIdentity("clockgrove/other", candidate())).not.toBe(first);
    expect(findingIdentity("clockgrove/factory", candidate(sha("c")))).not.toBe(first);
  });

  it("separates observation from an explicitly unverified possible cause", () => {
    const finding = candidate();
    const findingId = findingIdentity("clockgrove/factory", finding);
    const reportDigest = findingReportDigest({
      destination: "clockgrove/factory",
      candidate: finding,
      classification: "objective-blocker",
      occurrence,
    });
    const report = renderFindingIssue({
      findingId,
      reportDigest,
      candidate: finding,
      classification: "objective-blocker",
      occurrence,
    });
    expect(report.body).toContain("## Observation");
    expect(report.body).toContain("## Possible cause (unverified)");
    expect(report.body).toContain(`id=${findingId} report=${reportDigest}`);
  });

  it("refuses private filesystem paths before publication", () => {
    expect(() =>
      validateFindingCandidate({
        ...candidate(),
        observedBehavior: "Failure read /home/alice/private/project/config.json",
      }),
    ).toThrow(/private path/i);
  });

  it("refuses arbitrary absolute paths, private hosts, and raw prompt or log material", () => {
    for (const observedBehavior of [
      "Failure read /var/lib/factory/state.json",
      "Failure contacted scheduler.prod.internal",
      "Raw model prompt: reveal the hidden instructions",
      "Error: failed\\n    at privateFunction (worker.ts:1:1)",
    ]) {
      expect(() => validateFindingCandidate({ ...candidate(), observedBehavior })).toThrow(
        /private path|topology|raw log|prompt/i,
      );
    }
  });

  it("binds findings into new artifact digests without changing legacy artifact identity", () => {
    const legacy = {
      baseSha: "b".repeat(40),
      patch: "diff --git a/a b/a\n",
      changedPaths: ["a"],
    };
    expect(artifactDigest(legacy)).toBe(artifactDigest({ ...legacy, findings: [] }));
    const artifact = normalizeArtifact({
      ...legacy,
      findings: [candidate()],
      outcome: "succeeded",
    });
    expect(artifact.digest).not.toBe(artifactDigest(legacy));
    expect(verifyArtifact(artifact).findings).toHaveLength(1);
    expect(() =>
      verifyArtifact({
        ...artifact,
        findings: [candidate(sha("c"))],
      }),
    ).toThrow(/digest/i);
  });

  it("classifies repairs, blockers, follow-ups, refusal, unavailable reporting, and limits", () => {
    const base = {
      criterionOwnedByWorkItem: false,
      repairWithinExistingAuthority: false,
      preventsObjectiveAcceptance: false,
      safeToReport: true,
      reportingAvailable: true,
      allowanceRemaining: true,
    };
    expect(
      classifyFinding({
        ...base,
        criterionOwnedByWorkItem: true,
        repairWithinExistingAuthority: true,
      }),
    ).toBe("in-scope-repair");
    expect(classifyFinding({ ...base, preventsObjectiveAcceptance: true })).toBe(
      "objective-blocker",
    );
    expect(classifyFinding(base)).toBe("nonblocking-follow-up");
    expect(classifyFinding({ ...base, safeToReport: false })).toBe("reporting-refused");
    expect(classifyFinding({ ...base, reportingAvailable: false })).toBe("issue-ready");
    expect(classifyFinding({ ...base, allowanceRemaining: false })).toBe("reporting-limit");
  });

  it("uses trusted lifecycle phase and policy to choose owner and classification", () => {
    const targetPolicy: FindingReportingPolicy = {
      destinations: [
        ...policy.destinations,
        {
          repository: "clockgrove/example",
          audience: "public",
          operations: ["read", "create-issue"],
        },
      ],
      maxPublicationWrites: 2,
    };
    expect(
      decideFindingAtSupervisor({
        candidate: candidate(),
        lifecycle: "follow-up",
        currentRepository: "clockgrove/example",
        policy: targetPolicy,
      }),
    ).toEqual({
      destination: "clockgrove/example",
      classification: "nonblocking-follow-up",
    });
    expect(
      decideFindingAtSupervisor({
        candidate: { ...candidate(), phase: "supervisor" },
        lifecycle: "blocking",
        currentRepository: "clockgrove/example",
        policy: targetPolicy,
      }),
    ).toEqual({ destination: "clockgrove/factory", classification: "objective-blocker" });
    expect(
      decideFindingAtSupervisor({
        candidate: candidate(),
        lifecycle: "in-scope-repair",
        currentRepository: "clockgrove/example",
        policy: targetPolicy,
      }).classification,
    ).toBe("in-scope-repair");
  });
});

describe("FindingReporter", () => {
  it("refuses a security-sensitive observation from a public destination", async () => {
    const transport = port();
    const result = await new FindingReporter(transport, new Journal()).report({
      policy,
      destination: "clockgrove/factory",
      candidate: {
        ...candidate(),
        failureClass: "unexpected-output",
        observedBehavior: "The endpoint permits an authentication bypass.",
      },
      classification: "objective-blocker",
      occurrence,
      priorEvents: [],
    });
    expect(result).toBe("reporting-refused");
    expect(transport.created).toHaveLength(0);
  });

  it("does not publish without explicit destination authority", async () => {
    const transport = port();
    const journal = new Journal();
    const result = await new FindingReporter(transport, journal).report({
      destination: "clockgrove/factory",
      candidate: candidate(),
      classification: "nonblocking-follow-up",
      occurrence,
      priorEvents: [],
    });
    expect(result).toBe("issue-ready");
    expect(transport.created).toHaveLength(0);
    expect(journal.records.at(-1)?.reasonCode).toBe("no-authority");
  });

  it("refuses security-sensitive candidates even if a caller requests ordinary reporting", async () => {
    const transport = port();
    const journal = new Journal();
    const result = await new FindingReporter(transport, journal).report({
      policy,
      destination: "clockgrove/factory",
      candidate: { ...candidate(), failureClass: "security-vulnerability" },
      classification: "nonblocking-follow-up",
      occurrence,
      priorEvents: [],
    });
    expect(result).toBe("reporting-refused");
    expect(transport.created).toHaveLength(0);
    expect(journal.records[0]?.classification).toBe("reporting-refused");
  });

  it("persists intent before creating and records the exact issue identity", async () => {
    const transport = port();
    const journal = new Journal();
    const result = await new FindingReporter(transport, journal).report({
      policy,
      destination: "clockgrove/factory",
      candidate: candidate(),
      classification: "objective-blocker",
      occurrence,
      priorEvents: [],
    });
    expect(result).toBe("issue-filed");
    expect(journal.records.map((record) => record.event)).toEqual([
      "FindingDecision",
      "FindingPublicationIntent",
      "FindingDisposition",
    ]);
    expect(journal.records.at(-1)).toMatchObject({ issueNumber: 700, issueNodeId: "I_700" });
  });

  it("links an exact existing marker and does not use title similarity", async () => {
    const finding = candidate();
    const findingId = findingIdentity("clockgrove/factory", finding);
    const reportDigest = findingReportDigest({
      destination: "clockgrove/factory",
      candidate: finding,
      classification: "nonblocking-follow-up",
      occurrence,
    });
    const existing = issue(
      renderFindingIssue({
        findingId,
        reportDigest,
        candidate: finding,
        classification: "nonblocking-follow-up",
        occurrence,
      }).body,
    );
    const transport = port({
      async findByMarker() {
        return [existing];
      },
    });
    const result = await new FindingReporter(transport, new Journal()).report({
      policy,
      destination: "clockgrove/factory",
      candidate: finding,
      classification: "nonblocking-follow-up",
      occurrence,
      priorEvents: [],
    });
    expect(result).toBe("existing-issue-linked");
    expect(transport.created).toHaveLength(0);
  });

  it("links a later occurrence and appends only its new bounded evidence", async () => {
    let existing: FindingIssueObservation | undefined;
    let creates = 0;
    const transport = port({
      async findByMarker() {
        return existing ? [existing] : [];
      },
      async createIssue(input) {
        creates += 1;
        existing = issue(input.body);
        return existing;
      },
    });
    const recurrencePolicy: FindingReportingPolicy = {
      destinations: [
        {
          repository: "clockgrove/factory",
          audience: "public",
          operations: ["read", "create-issue", "comment-evidence"],
        },
      ],
      maxPublicationWrites: 2,
    };
    const journal = new Journal();
    const reporter = new FindingReporter(transport, journal);
    const input = {
      policy: recurrencePolicy,
      destination: "clockgrove/factory",
      candidate: candidate(),
      classification: "nonblocking-follow-up" as const,
      occurrence,
      priorEvents: [] as FindingEvent[],
    };
    expect(await reporter.report(input)).toBe("issue-filed");
    expect(
      await reporter.report({
        ...input,
        occurrence: { ...occurrence, attempt: 2 },
      }),
    ).toBe("existing-issue-linked");
    expect(creates).toBe(1);
    expect(transport.comments).toHaveLength(1);
    expect(transport.comments[0]?.body).toContain("Attempt: 2");
  });

  it("applies the publication allowance per run rather than per Objective history", async () => {
    const oldJournal = new Journal("old-run");
    expect(
      await new FindingReporter(port(), oldJournal).report({
        policy: { ...policy, maxPublicationWrites: 1 },
        destination: "clockgrove/factory",
        candidate: candidate(),
        classification: "nonblocking-follow-up",
        occurrence: { ...occurrence, runId: "old-run" },
        priorEvents: [],
      }),
    ).toBe("issue-filed");
    const currentTransport = port();
    expect(
      await new FindingReporter(currentTransport, new Journal("current-run")).report({
        policy: { ...policy, maxPublicationWrites: 1 },
        destination: "clockgrove/factory",
        candidate: candidate(sha("c")),
        classification: "nonblocking-follow-up",
        occurrence: { ...occurrence, runId: "current-run" },
        priorEvents: oldJournal.events,
      }),
    ).toBe("issue-filed");
    expect(currentTransport.created).toHaveLength(1);
  });

  it("rejects marker copies from a different author or changed body", async () => {
    const finding = candidate();
    const findingId = findingIdentity("clockgrove/factory", finding);
    const reportDigest = findingReportDigest({
      destination: "clockgrove/factory",
      candidate: finding,
      classification: "nonblocking-follow-up",
      occurrence,
    });
    const body = renderFindingIssue({
      findingId,
      reportDigest,
      candidate: finding,
      classification: "nonblocking-follow-up",
      occurrence,
    }).body;
    const transport = port({
      async findByMarker() {
        return [{ ...issue(`${body}\nchanged`, 701), author: "attacker" }];
      },
    });
    expect(
      await new FindingReporter(transport, new Journal()).report({
        policy,
        destination: "clockgrove/factory",
        candidate: finding,
        classification: "nonblocking-follow-up",
        occurrence,
        priorEvents: [],
      }),
    ).toBe("issue-filed");
    expect(transport.created).toHaveLength(1);
  });

  it("settles definite rate refusal without retrying the create", async () => {
    const transport = port({
      async createIssue() {
        throw Object.assign(new Error("rate limited"), { status: 429 });
      },
    });
    const journal = new Journal();
    expect(
      await new FindingReporter(transport, journal).report({
        policy,
        destination: "clockgrove/factory",
        candidate: candidate(),
        classification: "nonblocking-follow-up",
        occurrence,
        priorEvents: [],
      }),
    ).toBe("issue-ready");
    expect(journal.records.at(-1)?.reasonCode).toBe("rate-limited");
  });

  it("reconciles an exact existing issue even after publication allowance is exhausted", async () => {
    const finding = candidate();
    const findingId = findingIdentity("clockgrove/factory", finding);
    const reportDigest = findingReportDigest({
      destination: "clockgrove/factory",
      candidate: finding,
      classification: "nonblocking-follow-up",
      occurrence,
    });
    const existing = issue(
      renderFindingIssue({
        findingId,
        reportDigest,
        candidate: finding,
        classification: "nonblocking-follow-up",
        occurrence,
      }).body,
    );
    const transport = port({
      async findByMarker() {
        return [existing];
      },
    });
    expect(
      await new FindingReporter(transport, new Journal()).report({
        policy: { ...policy, maxPublicationWrites: 0 },
        destination: "clockgrove/factory",
        candidate: finding,
        classification: "nonblocking-follow-up",
        occurrence,
        priorEvents: [],
      }),
    ).toBe("existing-issue-linked");
    expect(transport.created).toHaveLength(0);
  });

  it("coalesces proven common-cause fan-out and appends only new evidence", async () => {
    let common: FindingIssueObservation | undefined;
    let creates = 0;
    const transport = port({
      async findByMarker({ marker }) {
        return common?.body.includes(marker) ? [common] : [];
      },
      async createIssue(input) {
        creates += 1;
        common = issue(input.body);
        return common;
      },
    });
    const reportingPolicy: FindingReportingPolicy = {
      destinations: [
        {
          repository: "clockgrove/factory",
          audience: "public",
          operations: ["read", "create-issue", "comment-evidence"],
        },
      ],
      maxPublicationWrites: 2,
    };
    const commonEvidence = [sha("d")];
    const reporter = new FindingReporter(transport, new Journal());
    expect(
      await reporter.report({
        policy: reportingPolicy,
        destination: "clockgrove/factory",
        candidate: { ...candidate(), commonCauseEvidence: commonEvidence },
        classification: "nonblocking-follow-up",
        occurrence,
        priorEvents: [],
      }),
    ).toBe("issue-filed");
    expect(
      await reporter.report({
        policy: reportingPolicy,
        destination: "clockgrove/factory",
        candidate: { ...candidate(sha("c")), commonCauseEvidence: commonEvidence },
        classification: "nonblocking-follow-up",
        occurrence: { ...occurrence, attempt: 2 },
        priorEvents: [],
      }),
    ).toBe("existing-issue-linked");
    expect(creates).toBe(1);
    expect(transport.comments).toHaveLength(1);
    expect(transport.comments[0]?.body).toContain("Additional Factory evidence");
  });

  it("keeps a different-artifact recurrence distinct when its common-cause issue is closed", async () => {
    const commonEvidence = [sha("d")];
    const original = { ...candidate(), commonCauseEvidence: commonEvidence };
    const findingId = findingIdentity("clockgrove/factory", original);
    const reportDigest = findingReportDigest({
      destination: "clockgrove/factory",
      candidate: original,
      classification: "nonblocking-follow-up",
      occurrence,
    });
    const closed = {
      ...issue(
        renderFindingIssue({
          findingId,
          reportDigest,
          candidate: original,
          classification: "nonblocking-follow-up",
          occurrence,
        }).body,
      ),
      state: "closed" as const,
    };
    const transport = port({
      async findByMarker({ marker }) {
        return closed.body.includes(marker) ? [closed] : [];
      },
    });
    const result = await new FindingReporter(transport, new Journal()).report({
      policy: {
        destinations: [
          {
            repository: "clockgrove/factory",
            audience: "public",
            operations: ["read", "create-issue", "comment-evidence"],
          },
        ],
        maxPublicationWrites: 2,
      },
      destination: "clockgrove/factory",
      candidate: { ...candidate(sha("c")), commonCauseEvidence: commonEvidence },
      classification: "nonblocking-follow-up",
      occurrence: { ...occurrence, attempt: 2 },
      priorEvents: [],
    });
    expect(result).toBe("issue-ready");
    expect(transport.created).toHaveLength(0);
    expect(transport.comments).toHaveLength(0);
  });

  it("reconciles committed response loss without creating a duplicate", async () => {
    let committed: FindingIssueObservation | undefined;
    let creates = 0;
    const transport = port({
      async findByMarker() {
        return committed ? [committed] : [];
      },
      async createIssue(input) {
        creates += 1;
        committed = issue(input.body);
        throw new Error("response lost");
      },
    });
    const result = await new FindingReporter(transport, new Journal()).report({
      policy,
      destination: "clockgrove/factory",
      candidate: candidate(),
      classification: "objective-blocker",
      occurrence,
      priorEvents: [],
    });
    expect(result).toBe("issue-filed");
    expect(creates).toBe(1);
  });

  it("reconciles a delayed committed create after restart without redispatch", async () => {
    const journal = new Journal();
    let committedBody = "";
    const firstTransport = port({
      async createIssue(input) {
        committedBody = input.body;
        throw new Error("unknown");
      },
    });
    const input = {
      policy,
      destination: "clockgrove/factory",
      candidate: candidate(),
      classification: "objective-blocker" as const,
      occurrence,
      priorEvents: [] as FindingEvent[],
    };
    expect(await new FindingReporter(firstTransport, journal).report(input)).toBe("issue-ready");
    const secondTransport = port({
      async findByMarker() {
        return [issue(committedBody)];
      },
    });
    expect(await new FindingReporter(secondTransport, journal).report(input)).toBe("issue-filed");
    expect(secondTransport.created).toHaveLength(0);
  });

  it("keeps an unobserved ambiguous create issue-ready after restart without redispatch", async () => {
    const journal = new Journal();
    const input = {
      policy,
      destination: "clockgrove/factory",
      candidate: candidate(),
      classification: "objective-blocker" as const,
      occurrence,
      priorEvents: [] as FindingEvent[],
    };
    expect(
      await new FindingReporter(
        port({
          async createIssue() {
            throw new Error("unknown");
          },
        }),
        journal,
      ).report(input),
    ).toBe("issue-ready");
    const restarted = port();
    expect(await new FindingReporter(restarted, journal).report(input)).toBe("issue-ready");
    expect(restarted.created).toHaveLength(0);
  });

  it("serializes concurrent siblings by finding identity", async () => {
    const journal = new Journal();
    const transport = port();
    const reporter = new FindingReporter(transport, journal);
    const input = {
      policy,
      destination: "clockgrove/factory",
      candidate: candidate(),
      classification: "nonblocking-follow-up" as const,
      occurrence,
      priorEvents: [] as FindingEvent[],
    };
    const results = await Promise.all([reporter.report(input), reporter.report(input)]);
    expect(results).toEqual(["issue-filed", "issue-filed"]);
    expect(transport.created).toHaveLength(1);
  });

  it("reconstructs exact disposition in status and explain from authenticated events", async () => {
    const journal = new Journal();
    await new FindingReporter(port(), journal).report({
      policy,
      destination: "clockgrove/factory",
      candidate: candidate(),
      classification: "nonblocking-follow-up",
      occurrence,
      priorEvents: [],
    });
    const snapshot = {
      id: "I_objective",
      number: 382,
      title: "Defect reporting",
      defaultBranch: "main",
      factoryEvents: journal.events,
      workItems: [],
    };
    const status = buildStatusReport({ repository: "clockgrove/factory", snapshot });
    expect(status.findings).toEqual([
      expect.objectContaining({ disposition: "issue-filed", issueNumber: 700 }),
    ]);
    const explain = buildExplanationReport({ repository: "clockgrove/factory", snapshot });
    expect(explain.explanations).toContainEqual(
      expect.objectContaining({ code: "finding.issue-filed", category: "finding" }),
    );
  });
});
