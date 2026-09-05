import { describe, expect, it, vi } from "vitest";
import { FactoryApplicationService } from "../src/application/services.js";
import type { RecoveryAssessment } from "../src/recovery/assessment.js";

const snapshot = {
  id: "objective-node",
  number: 7,
  title: "Private task body is not a report",
  defaultBranch: "main",
  factoryEvents: [],
  workItems: [],
};
const report: RecoveryAssessment = {
  operation: "recovery-plan",
  repository: "o/r",
  objective: 7,
  executionAuthorized: false,
  successorAvailable: false,
  availability: "incomplete",
  blockers: [{ code: "successor-unavailable", reason: "Successor execution is not implemented" }],
  runs: [],
  workItems: [],
  orphanReservations: [],
  reads: { performed: 0, limit: 512 },
};

describe("recovery assessment application boundary", () => {
  it("uses one Objective read and the explicit read-only assessment callback, without command authority", async () => {
    const readObjective = vi.fn(async () => snapshot);
    const assessRecovery = vi.fn(async () => report);
    const addIssueComment = vi.fn(async () => {
      throw new Error("unexpected write");
    });
    const getAuthenticatedLogin = vi.fn(async () => {
      throw new Error("unexpected authority read");
    });
    const service = new FactoryApplicationService({
      owner: "o",
      repo: "r",
      reader: { readObjective },
      assessRecovery,
      store: { addIssueComment, getAuthenticatedLogin, serverTime: async () => new Date() },
    });
    expect(await service.inspect("recovery-plan", 7)).toBe(report);
    expect(readObjective).toHaveBeenCalledExactlyOnceWith(7);
    expect(assessRecovery).toHaveBeenCalledExactlyOnceWith(snapshot);
    expect(addIssueComment).not.toHaveBeenCalled();
    expect(getAuthenticatedLogin).not.toHaveBeenCalled();
  });

  it("works without any command store or controller", async () => {
    const service = new FactoryApplicationService({
      owner: "o",
      repo: "r",
      reader: { readObjective: async () => snapshot },
      assessRecovery: async () => report,
    });
    expect(await service.inspect("recovery-plan", 7)).toMatchObject({ executionAuthorized: false });
  });

  it("fails explicitly when the evidence reader is unavailable, without dumping the private snapshot", async () => {
    const service = new FactoryApplicationService({
      owner: "o",
      repo: "r",
      reader: { readObjective: async () => snapshot },
    });
    await expect(service.inspect("recovery-plan", 7)).rejects.toThrow(
      "recovery assessment reader is not configured",
    );
  });

  it("cannot misrepresent a per-item view as a complete Objective assessment", async () => {
    const assessRecovery = vi.fn(async () => report);
    const service = new FactoryApplicationService({
      owner: "o",
      repo: "r",
      reader: { readObjective: async () => snapshot },
      assessRecovery,
    });
    await expect(service.inspect("recovery-plan", 7, 8)).rejects.toThrow("whole Objective");
    expect(assessRecovery).not.toHaveBeenCalled();
  });

  it("does not turn an unavailable observation into an activation or retry", async () => {
    const addIssueComment = vi.fn(async () => {});
    const service = new FactoryApplicationService({
      owner: "o",
      repo: "r",
      reader: { readObjective: async () => snapshot },
      assessRecovery: async () => {
        throw new Error("read unavailable");
      },
      store: {
        addIssueComment,
        getAuthenticatedLogin: async () => "operator",
        serverTime: async () => new Date(),
      },
    });
    await expect(service.inspect("recovery-plan", 7)).rejects.toThrow(
      "Recovery assessment unavailable",
    );
    expect(addIssueComment).not.toHaveBeenCalled();
  });

  it("sanitizes snapshot parser and provider failures before they reach MCP or CLI", async () => {
    const assessRecovery = vi.fn(async () => report);
    const service = new FactoryApplicationService({
      owner: "o",
      repo: "r",
      reader: {
        readObjective: async () => {
          throw new Error("PRIVATE-BODY provider-token=secret");
        },
      },
      assessRecovery,
    });
    let observed = "";
    try {
      await service.inspect("recovery-plan", 7);
    } catch (error) {
      observed = String(error);
    }
    expect(observed).toContain("Recovery assessment unavailable");
    expect(observed).not.toMatch(/PRIVATE-BODY|provider-token|secret/);
    expect(assessRecovery).not.toHaveBeenCalled();
  });
});
