import { describe, expect, it } from "vitest";

import type { PriorityPolicy } from "../src/scheduling/priority.js";
import { PriorityUnavailableError, rankReadyWorkItems } from "../src/scheduling/priority.js";
import type { DerivedWorkItem } from "../src/state.js";
import {
  normalizeIssueFieldValues,
  priorityPolicyFragment,
  validatePriorityFieldDefinition,
} from "../src/scheduling/github-priority.js";
import { GitHubReader } from "../src/github.js";

function item(
  number: number,
  options: {
    position?: number;
    dependencies?: Array<{ number: number; closed: boolean }>;
    closed?: boolean;
    state?: DerivedWorkItem["state"];
    optionId?: string;
    includeFieldSnapshot?: boolean;
  } = {},
): DerivedWorkItem {
  return {
    id: `I_${number}`,
    number,
    title: `Item ${number}`,
    body: "",
    closed: options.closed ?? false,
    state: options.state ?? "unstarted",
    attempts: 0,
    doneWithoutMergedPullRequest: false,
    assignees: [],
    labels: ["factory:work-item"],
    blockedBy: options.dependencies ?? [],
    linkedPullRequests: [],
    copilotAssignments: [],
    subIssuePosition: options.position ?? number - 1,
    ...(options.includeFieldSnapshot === false
      ? {}
      : {
          issueFieldValues: options.optionId
            ? [
                {
                  fieldId: "IF_priority",
                  fieldName: "Priority",
                  dataType: "SINGLE_SELECT" as const,
                  optionId: options.optionId,
                  optionName: options.optionId,
                },
              ]
            : [],
        }),
  };
}

const subIssuePolicy: PriorityPolicy = {
  source: "subissue-order",
  unsetRank: 100,
  onUnavailable: "fallback-to-subissue-order",
};

const fieldPolicy: PriorityPolicy = {
  source: "issue-field-then-subissue-order",
  issueFieldId: "IF_priority",
  optionRanks: { urgent: 0, high: 10, low: 100 },
  unsetRank: 50,
  onUnavailable: "fallback-to-subissue-order",
};

function permutations<T>(values: T[]): T[][] {
  if (values.length < 2) return [values];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidate) => candidate !== index)).map((rest) => [
      value,
      ...rest,
    ]),
  );
}

describe("deterministic Work Item priority", () => {
  it("normalizes stable field/option IDs and rejects a truncated connection", () => {
    expect(
      normalizeIssueFieldValues(1, {
        totalCount: 2,
        nodes: [
          {
            optionId: "urgent",
            name: "Urgent",
            field: { id: "IF_priority", name: "Priority", dataType: "SINGLE_SELECT" },
          },
          { field: { id: "IF_points", name: "Points", dataType: "NUMBER" } },
        ],
      }),
    ).toEqual([
      {
        fieldId: "IF_priority",
        fieldName: "Priority",
        dataType: "SINGLE_SELECT",
        optionId: "urgent",
        optionName: "Urgent",
      },
    ]);
    expect(() => normalizeIssueFieldValues(1, { totalCount: 2, nodes: [{}] })).toThrow(
      /complete snapshot/,
    );
  });

  it("paginates organization fields and emits stable ready-to-paste ranks", async () => {
    const requestFetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const body = (await request.json()) as { variables: { after?: string | null } };
      const second = body.variables.after === "page-2";
      return Response.json({
        data: {
          organization: {
            issueFields: {
              pageInfo: {
                hasNextPage: !second,
                endCursor: second ? null : "page-2",
              },
              nodes: second
                ? [
                    {
                      __typename: "IssueFieldSingleSelect",
                      id: "IF_priority",
                      name: "Priority",
                      dataType: "SINGLE_SELECT",
                      options: [
                        { id: "urgent", name: "Urgent" },
                        { id: "high", name: "High" },
                      ],
                    },
                  ]
                : [{ __typename: "IssueFieldText" }],
            },
          },
        },
      });
    };
    const fields = await new GitHubReader({
      token: "test-token",
      owner: "clockgrove",
      repo: "factory",
      requestFetch,
    }).readPriorityFields();
    expect(fields).toEqual([
      {
        id: "IF_priority",
        name: "Priority",
        options: [
          { id: "urgent", name: "Urgent", position: 0 },
          { id: "high", name: "High", position: 1 },
        ],
      },
    ]);
    expect(priorityPolicyFragment(fields[0]!)).toMatchObject({
      priority: {
        issueFieldId: "IF_priority",
        optionRanks: { urgent: 0, high: 10 },
      },
    });
    expect(
      validatePriorityFieldDefinition(
        { ...fieldPolicy, optionRanks: { urgent: 0, high: 10 } },
        fields,
      ),
    ).toEqual({ available: true });
    expect(
      validatePriorityFieldDefinition({ ...fieldPolicy, optionRanks: { deleted: 0 } }, fields),
    ).toMatchObject({ available: false, reason: expect.stringContaining("deleted") });
  });

  it("uses native sub-issue position before graph score by default", () => {
    const items = [
      item(1, { position: 2 }),
      item(2, { position: 0 }),
      item(3, { position: 1, dependencies: [{ number: 1, closed: false }] }),
    ];
    expect(rankReadyWorkItems(items, subIssuePolicy).map((x) => x.item.number)).toEqual([2, 1]);
  });

  it("applies an operator priority override without changing other Work Items", () => {
    const ranked = rankReadyWorkItems(
      [item(1, { position: 0 }), item(2, { position: 1 })],
      subIssuePolicy,
      undefined,
      new Set(),
      new Map([[2, 1]]),
    );
    expect(ranked.map((value) => value.item.number)).toEqual([2, 1]);
    expect(ranked[0]).toMatchObject({
      rank: 1,
      source: "operator-command",
    });
    expect(ranked[1]).toMatchObject({
      rank: 100,
      source: "subissue-order",
    });
  });

  it("ranks an explicitly stack-ready child without treating every blocked item as ready", () => {
    const items = [
      item(1, { position: 0 }),
      item(2, {
        position: 1,
        state: "blocked",
        dependencies: [{ number: 1, closed: false }],
      }),
      item(3, {
        position: 2,
        state: "blocked",
        dependencies: [{ number: 1, closed: false }],
      }),
    ];
    expect(
      rankReadyWorkItems(items, subIssuePolicy, undefined, new Set([2])).map(
        (value) => value.item.number,
      ),
    ).toEqual([1, 2]);
  });

  it("lets a pinned stable option ID override critical-path score", () => {
    const items = [
      item(1, { optionId: "low" }),
      item(2, { optionId: "urgent" }),
      item(3, {
        state: "blocked",
        dependencies: [{ number: 1, closed: false }],
      }),
    ];
    const ranked = rankReadyWorkItems(items, fieldPolicy);
    expect(ranked.map((x) => x.item.number)).toEqual([2, 1]);
    expect(ranked[1]).toMatchObject({
      criticalPathLength: 1,
      unfinishedDownstream: 1,
      fieldId: "IF_priority",
      optionId: "low",
    });
  });

  it("produces identical ordering for every input permutation", () => {
    const values = [
      item(10, { position: 3, optionId: "high" }),
      item(20, { position: 1, optionId: "high" }),
      item(30, { position: 2, optionId: "urgent" }),
      item(40, { position: 0 }),
    ];
    const orders = permutations(values).map((candidate) =>
      rankReadyWorkItems(candidate, fieldPolicy)
        .map((x) => x.item.number)
        .join(","),
    );
    expect(new Set(orders)).toEqual(new Set(["30,20,10,40"]));
  });

  it("falls back safely or escalates for an unpinned observed option", () => {
    const values = [
      item(1, { position: 0, optionId: "future-option" }),
      item(2, { position: 1, optionId: "urgent" }),
    ];
    expect(rankReadyWorkItems(values, fieldPolicy).map((x) => x.item.number)).toEqual([1, 2]);
    expect(
      rankReadyWorkItems(values, fieldPolicy).every((x) => x.source === "subissue-order-fallback"),
    ).toBe(true);
    expect(() => rankReadyWorkItems(values, { ...fieldPolicy, onUnavailable: "escalate" })).toThrow(
      PriorityUnavailableError,
    );
    expect(
      rankReadyWorkItems(values, fieldPolicy, "configured field was deleted").every(
        (value) =>
          value.source === "subissue-order-fallback" &&
          value.fallbackReason === "configured field was deleted",
      ),
    ).toBe(true);
  });

  it("rejects dependency cycles instead of inventing an order", () => {
    expect(() =>
      rankReadyWorkItems(
        [
          item(1, { dependencies: [{ number: 2, closed: false }] }),
          item(2, { dependencies: [{ number: 1, closed: false }] }),
        ],
        subIssuePolicy,
      ),
    ).toThrow(/cycle/);
  });
});
