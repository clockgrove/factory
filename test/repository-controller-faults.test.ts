import { describe, expect, it } from "vitest";
import { RepositoryController } from "../src/controller/repository-controller.js";
import {
  RepositoryControls,
  type RepositoryAdmission,
} from "../src/controller/repository-controls.js";
import type { LeaseManager, LeaseState } from "../src/control/lease.js";

const lease: LeaseState = {
  objective: 1,
  epoch: 1,
  ref: "refs/lease/1",
  oid: "a".repeat(40),
  treeOid: "b".repeat(40),
  runId: "run",
  holder: "controller",
  policyDigest: "c".repeat(64),
  sequence: 1,
  expiresAt: new Date("2099-01-01"),
};
const manager = { assertGeneration: async () => {} } as unknown as LeaseManager;

describe("repository controller interruption recovery", () => {
  it.each(["after-admission", "after-publication"])(
    "restarts %s with exactly-once durable effects",
    async (fault) => {
      const durable = {
        admitted: new Set<number>(),
        published: new Set<number>(),
      };
      let admissionWrites = 0;
      let publicationWrites = 0;
      let interrupted = false;
      const source = {
        discover: async () => [{ number: 1 }],
        admissions: async (): Promise<RepositoryAdmission[]> =>
          durable.published.has(10)
            ? []
            : [{ objective: 1, workItem: 10, lease }],
        reconcile: async (_objective: number, item: RepositoryAdmission) => {
          if (!durable.admitted.has(item.workItem)) {
            durable.admitted.add(item.workItem);
            admissionWrites += 1;
          } // deterministic attempt ref
          if (!interrupted && fault === "after-admission") {
            interrupted = true;
            throw new Error("power loss");
          }
          if (!durable.published.has(item.workItem)) {
            durable.published.add(item.workItem);
            publicationWrites += 1;
          } // deterministic branch/PR recovery
          if (!interrupted && fault === "after-publication") {
            interrupted = true;
            throw new Error("power loss");
          }
        },
      };
      for (let restart = 0; restart < 2; restart += 1) {
        const controller = new RepositoryController({
          source,
          controls: new RepositoryControls(1, 1, manager),
        });
        await controller.reconcileOnce();
        await controller.settle();
      }
      expect([...durable.admitted]).toEqual([10]);
      expect([...durable.published]).toEqual([10]);
      expect(admissionWrites).toBe(1);
      expect(publicationWrites).toBe(1);
    },
  );
});
