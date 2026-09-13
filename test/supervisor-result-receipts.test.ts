import { afterEach, describe, expect, it, vi } from "vitest";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";
import { decodeEventComments } from "../src/control/receipts.js";
import {
  decodeResultReceiptComments,
  RESULT_RECORD_PROTOCOL,
} from "../src/control/result-receipts.js";
import { unresolvedModelInvocations } from "../src/control/budget.js";
import { IssueAdmissionLedger } from "../src/control/issue-admission.js";
import { GitHubControlStore } from "../src/control/github-store.js";
import { PlatformUnavailableError } from "../src/platform.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Supervisor consolidated result lifecycle (simulated providers, real local Git)", () => {
  it("recovers a lost integration receipt from consolidated results in a new Supervisor without repeating work", async () => {
    const f = await providerSupervisorFixture("daytona-burst", {
      controllerActivation: true,
      dependencyChain: true,
      localOnly: true,
      recordProtocol: RESULT_RECORD_PROTOCOL,
      loseIntegrationReceipt: "before",
    });
    try {
      await expect(f.run()).rejects.toBeInstanceOf(PlatformUnavailableError);
      const original = f.publishedComments.filter((comment) =>
        decodeResultReceiptComments(comment.body).some((receipt) => receipt.workItem === 8),
      );
      expect(original).toHaveLength(2);
      const firstBudget = f
        .events()
        .filter((event) => event.kind === "budget" && event.workItem === 8);
      const resumed = await f.run();
      expect(resumed, resumed.reason).toMatchObject({ status: "completed", runId: f.runId });
      expect(
        f.publishedComments.filter((comment) =>
          decodeResultReceiptComments(comment.body).some((receipt) => receipt.workItem === 8),
        ),
      ).toEqual(original);
      expect(f.events().filter((event) => event.kind === "budget" && event.workItem === 8)).toEqual(
        firstBudget,
      );
      expect(
        f.activity.filter((event) => event.operation === "launch").map((event) => event.workItem),
      ).toEqual([8, 9, 10]);
      expect(
        f.activity.filter((event) => event.operation === "review" && event.workItem === 8),
      ).toHaveLength(1);
      expect(
        f.events().filter((event) => event.event === "AttemptIntegrated" && event.workItem === 8),
      ).toHaveLength(1);
      expect(unresolvedModelInvocations(f.events(), f.runId)).toEqual([]);
      expect(f.resources.size).toBe(0);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("retains known usage and rejects acceptance with unmet criteria", async () => {
    const f = await providerSupervisorFixture("daytona-burst", {
      dependencyChain: true,
      localOnly: true,
      recordProtocol: RESULT_RECORD_PROTOCOL,
      reviewUnmetCriteria: true,
    });
    try {
      const result = await f.run();
      expect(result.status).toBe("escalated");
      const reviews = f.publishedComments.filter((comment) =>
        decodeResultReceiptComments(comment.body).some((receipt) => receipt.kind === "review"),
      );
      expect(reviews).toHaveLength(1);
      expect(decodeEventComments(reviews[0]!.body)).toMatchObject([
        { event: "BudgetReconciled", phase: "management", amount: 6 },
      ]);
      expect(f.events().filter((event) => event.event === "AttemptValidated")).toEqual([]);
      expect(f.events().filter((event) => event.event === "AttemptIntegrated")).toEqual([]);
      expect(unresolvedModelInvocations(f.events(), f.runId)).toEqual([]);
      expect(f.resources.size).toBe(0);
      const reviewCalls = f.activity.filter((event) => event.operation === "review");
      const closures = f.events().filter((event) => event.event === "BudgetReconciled");
      await f.run();
      expect(f.activity.filter((event) => event.operation === "review")).toEqual(reviewCalls);
      expect(f.events().filter((event) => event.event === "BudgetReconciled")).toEqual(closures);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it.each([false, true])(
    "finishes with one authenticated publication per result, lost acknowledgment=%s",
    async (lost) => {
      const f = await providerSupervisorFixture("daytona-burst", {
        dependencyChain: true,
        localOnly: true,
        recordProtocol: RESULT_RECORD_PROTOCOL,
        ...(lost ? { loseResultReceiptResponse: true } : {}),
      });
      try {
        const result = await f.run();
        expect(
          result,
          `${result.reason}; ${f
            .events()
            .filter((event) => event.event === "AttemptFailed")
            .map((event) => ("reason" in event ? event.reason : ""))
            .join(";")}`,
        ).toMatchObject({ status: "completed" });
        const receipts = f.publishedComments.flatMap((comment) =>
          decodeResultReceiptComments(comment.body).map((receipt) => ({
            ...comment,
            receipt,
            events: decodeEventComments(comment.body),
          })),
        );
        expect(receipts).toHaveLength(6);
        expect(receipts.filter((value) => value.receipt.kind === "validation")).toHaveLength(3);
        const reviews = receipts.filter((value) => value.receipt.kind === "review");
        expect(reviews).toHaveLength(3);
        for (const review of reviews)
          expect(review.events.map((event) => event.event)).toEqual([
            "BudgetReconciled",
            "AttemptValidated",
          ]);
        expect(new Set(receipts.map((value) => value.commentId)).size).toBe(6);
        expect([...f.refs.keys()].filter((ref) => /\/(validations|reviews)\//.test(ref))).toEqual(
          [],
        );
        expect(f.events().filter((event) => event.event === "ValidationRecorded")).toHaveLength(3);
        expect(f.events().filter((event) => event.event === "AttemptValidated")).toHaveLength(3);
        expect(f.events().filter((event) => event.event === "AttemptIntegrated")).toHaveLength(3);
        const modelClosures = f
          .events()
          .filter(
            (event) =>
              event.kind === "budget" &&
              event.event === "BudgetReconciled" &&
              event.unit === "model_tokens",
          );
        expect(modelClosures).toHaveLength(6);
        expect(
          modelClosures.map((event) => (event.kind === "budget" ? event.amount : null)),
        ).toEqual([6, 6, 6, 6, 6, 6]);
        expect(unresolvedModelInvocations(f.events(), f.runId)).toEqual([]);
        const publications = f.publishedComments.filter((comment) =>
          decodeEventComments(comment.body).some((event) => event.event === "PublicationRecorded"),
        );
        expect(publications).toHaveLength(3);
        for (const publication of publications)
          expect(decodeEventComments(publication.body).map((event) => event.event)).toEqual([
            "AttemptPublished",
            "PublicationRecorded",
          ]);
        const store = new GitHubControlStore({
          token: "fixture",
          owner: "fixture",
          repo: "provider-qualification",
        });
        for (const item of [8, 9, 10]) {
          const ledger = await new IssueAdmissionLedger(store).read(item);
          expect(ledger!.history).toHaveLength(1);
          expect(ledger!.history[0]).toMatchObject({
            disposition: "released",
            dispatchPossible: true,
          });
        }
        expect(f.activity.filter((event) => event.operation === "launch")).toHaveLength(3);
        expect(
          f.activity.filter((event) => ["review", "candidate-review"].includes(event.operation)),
        ).toHaveLength(3);
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );
});
