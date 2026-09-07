import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertHeldInnerRefusal,
  assertInnerContentionWindow,
  withFrozenController,
  type FreezeHelper,
} from "../scripts/qualification-controller-freeze.mjs";

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 6, 0, 0, seconds)).toISOString();
const outer = {
  oid: "a".repeat(40),
  record: {
    event: "RepositoryLeaseRenewed",
    expiresAt: at(600),
    controllerId: "old",
    epoch: 3,
    policyDigest: "a".repeat(64),
  },
};
const inner = {
  oid: "b".repeat(40),
  event: {
    kind: "lease",
    event: "LeaseRenewed",
    expiresAt: at(780),
    objective: 7,
    holder: "operator-original",
  },
};
const acquired = {
  oid: "c".repeat(40),
  parents: [outer.oid],
  record: {
    event: "RepositoryLeaseAcquired",
    previousOid: outer.oid,
    controllerId: "contender",
    epoch: 4,
    policyDigest: "b".repeat(64),
  },
};
const released = {
  oid: "d".repeat(40),
  parents: [acquired.oid],
  record: { ...acquired.record, event: "RepositoryLeaseReleased", previousOid: acquired.oid },
};
const refusal = {
  response: {
    isError: true,
    content: [{ type: "text", text: "Objective #7 is leased by operator-original" }],
  },
  objective: 7,
  outer,
  inner,
  afterInner: inner,
  acquired,
  released,
};

describe("observed safe inner contention window", () => {
  it("uses actual server observations, never the requested initial delay as expiry proof", () => {
    expect(
      assertInnerContentionWindow({
        outer: outer.record,
        inner: inner.event,
        serverTime: at(0),
        remainingMs: 2400000,
      }),
    ).toMatchObject({ separationMs: 180000, maximumMs: 750000 });
    expect(() =>
      assertInnerContentionWindow({
        outer: outer.record,
        inner: { ...inner.event, expiresAt: at(779) },
        serverTime: at(0),
        remainingMs: 2400000,
      }),
    ).toThrow(/observed expiry separation/);
    expect(() =>
      assertInnerContentionWindow({
        outer: outer.record,
        inner: inner.event,
        serverTime: at(590),
        remainingMs: 2400000,
      }),
    ).toThrow(/preparation time/);
    expect(() =>
      assertInnerContentionWindow({
        outer: outer.record,
        inner: inner.event,
        serverTime: at(0),
        remainingMs: 1080000,
      }),
    ).toThrow(/unchanged scenario deadline/);
  });
  it("refuses already released leases or excessive later expiry before any process signal", () => {
    expect(() =>
      assertInnerContentionWindow({
        outer: { ...outer.record, event: "RepositoryLeaseReleased" },
        inner: inner.event,
        serverTime: at(0),
        remainingMs: 2400000,
      }),
    ).toThrow();
    expect(() =>
      assertInnerContentionWindow({
        outer: outer.record,
        inner: { ...inner.event, expiresAt: at(901) },
        serverTime: at(0),
        remainingMs: 2400000,
      }),
    ).toThrow(/bounded follow-up wait/);
  });
});

describe("actual installed inner-lock refusal proof", () => {
  it("requires fresh outer acquisition/release and the unchanged still-held inner identity", () => {
    expect(() => assertHeldInnerRefusal(refusal)).not.toThrow();
  });
  it("does not accept the outer refusal as inner contention or an unexplained outer generation", () => {
    expect(() =>
      assertHeldInnerRefusal({
        ...refusal,
        response: {
          isError: true,
          content: [{ type: "text", text: "another repository controller holds the lease" }],
        },
      }),
    ).toThrow(/still-held inner Director/);
    expect(() =>
      assertHeldInnerRefusal({
        ...refusal,
        acquired: { ...acquired, record: { ...acquired.record, epoch: 5 } },
      }),
    ).toThrow();
    expect(() =>
      assertHeldInnerRefusal({ ...refusal, afterInner: { ...inner, oid: "e".repeat(40) } }),
    ).toThrow(/changed the inner lease/);
  });
});

function lifecycle(fault?: "primary-killed" | "both-killed" | "permission") {
  const messages: string[] = [];
  const start = (_spec: Record<string, unknown>, role: string): FreezeHelper => {
    messages.push(`start:${role}`);
    const records = [{ state: role === "primary" ? "frozen" : "armed" }];
    let end!: (value: { closed: boolean; records: Array<{ state: string }> }) => void;
    const ended = new Promise<{ closed: boolean; records: Array<{ state: string }> }>((resolve) => {
      end = resolve;
    });
    return {
      records,
      ended,
      closed: false,
      ready:
        fault === "permission" && role === "watchdog"
          ? Promise.reject(Error("pidfd permission refused before freeze"))
          : Promise.resolve(records[0]),
      release: (command = "continue\n") => {
        messages.push(`${role}:${command.trim()}`);
        if (
          fault !== "both-killed" &&
          !(fault === "primary-killed" && role === "primary") &&
          fault !== "permission"
        )
          records.push({
            state: command === "disarm\n" ? "disarmed" : "continued-exact-incarnation",
          });
        end({ closed: true, records });
      },
    };
  };
  return { start, messages };
}
const spec = {
  pid: 999999,
  uid: 1000,
  startTicks: "1234",
  invocationId: "a".repeat(32),
  unit: "clockgrove-factory-fixture.service",
  configPath: join(homedir(), ".config/systemd/user/clockgrove-factory-fixture.service"),
};

describe("finally-scoped exact thaw ownership", () => {
  it("arms independent backup before freeze and disarms it only after observed primary thaw", async () => {
    const f = lifecycle(),
      records: Record<string, unknown>[] = [];
    await expect(
      withFrozenController(
        spec,
        async (assertFrozen) => {
          assertFrozen();
          return "done";
        },
        (value) => records.push(value),
        f.start,
      ),
    ).resolves.toBe("done");
    expect(f.messages).toEqual([
      "start:watchdog",
      "start:primary",
      "primary:continue",
      "watchdog:disarm",
    ]);
    expect(records.at(-1)).toMatchObject({ state: "thaw-observed" });
  });
  it("thaws on observer failure without retrying the operation", async () => {
    const f = lifecycle();
    let calls = 0;
    await expect(
      withFrozenController(
        spec,
        async () => {
          calls++;
          throw Error("observer lost");
        },
        () => {},
        f.start,
      ),
    ).rejects.toThrow("observer lost");
    expect(calls).toBe(1);
    expect(f.messages).toContain("primary:continue");
  });
  it("uses independent exact thaw if primary helper was killed", async () => {
    const f = lifecycle("primary-killed"),
      records: Record<string, unknown>[] = [];
    await withFrozenController(
      spec,
      async () => {},
      (value) => records.push(value),
      f.start,
    );
    expect(f.messages).toContain("watchdog:continue");
    expect(records.at(-1)).toMatchObject({ state: "thaw-observed" });
  });
  it("does not pretend both-helper loss guarantees cleanup", async () => {
    const f = lifecycle("both-killed"),
      records: Record<string, unknown>[] = [];
    await expect(
      withFrozenController(
        spec,
        async () => {},
        (value) => records.push(value),
        f.start,
      ),
    ).rejects.toThrow(/thaw unverified/);
    expect(records.at(-1)).toMatchObject({
      state: "potentially-frozen-manual-reconciliation-required",
    });
  });
  it("does not start a freezing helper when pidfd inspection/permission fails", async () => {
    const f = lifecycle("permission"),
      records: Record<string, unknown>[] = [];
    await expect(
      withFrozenController(
        spec,
        async () => {
          throw Error("must not execute");
        },
        (value) => records.push(value),
        f.start,
      ),
    ).rejects.toThrow(/permission refused/);
    expect(f.messages).not.toContain("start:primary");
    expect(records.at(-1)).toMatchObject({ state: "freeze-not-started" });
  });
});
