import { describe, expect, it } from "vitest";

import { bindAuthenticatedRunActors } from "../src/control/authenticated-events.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";

const SHA = "a".repeat(40);
const digest = policyDigest(DEFAULT_RUN_POLICY);
const activation = parseFactoryEvent({
  protocol: "clockgrove.factory/v2",
  kind: "run",
  event: "ActivationRequested",
  objective: 7,
  runId: "activate-7",
  sequence: 1,
  at: "2026-09-03T00:00:00.000Z",
  requestedBy: "operator",
  requestId: "activate-7",
  repository: "clockgrove/factory",
  baseSha: SHA,
  policy: DEFAULT_RUN_POLICY,
  policyDigest: digest,
  controllerProtocolMin: "clockgrove.factory/v2",
  controllerProtocolMax: "clockgrove.factory/v2",
});
const started = parseFactoryEvent({
  protocol: "clockgrove.factory/v2",
  kind: "run",
  event: "FactoryRunStarted",
  objective: 7,
  runId: "run-7",
  sequence: 2,
  at: "2026-09-03T00:00:01.000Z",
  actor: "operator",
  repository: "clockgrove/factory",
  objectiveAuthor: "operator",
  fork: false,
  baseBranch: "main",
  policy: DEFAULT_RUN_POLICY,
  policyDigest: digest,
  activationRequestId: "activate-7",
  baseSha: SHA,
});

describe("authenticated run actor binding", () => {
  it("binds a controller start to its authenticated activation", () => {
    expect(
      bindAuthenticatedRunActors([
        { event: activation, login: "operator" },
        { event: started, login: "operator" },
      ]),
    ).toEqual(new Map([["run-7", "operator"]]));
  });

  it("fails closed when a collaborator reuses an existing run ID", () => {
    const forged = parseFactoryEvent({
      ...started,
      actor: "collaborator",
    });
    expect(() =>
      bindAuthenticatedRunActors([
        { event: activation, login: "operator" },
        { event: started, login: "operator" },
        { event: forged, login: "collaborator" },
      ]),
    ).toThrow(/conflicting authenticated actors/i);
  });

  it("rejects a start whose activation binding changed", () => {
    const mismatched = parseFactoryEvent({
      ...started,
      baseSha: "b".repeat(40),
    });
    expect(() =>
      bindAuthenticatedRunActors([
        { event: activation, login: "operator" },
        { event: mismatched, login: "operator" },
      ]),
    ).toThrow(/does not match its authenticated activation/i);
  });
});
