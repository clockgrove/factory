import assert from "node:assert/strict";
import test from "node:test";
import { phaseAdmission } from "../dist/phase-admission.js";
import { readyItems } from "../dist/scheduler.js";

function fixture(limit = 2) {
  const config = {
    execution: { concurrency: 3 },
    scheduling: {
      cpu: limit,
      memoryMiB: limit * 100,
      reviewConcurrency: 1,
      validationConcurrency: 1,
      phases: Object.fromEntries(
        ["coding", "validation", "review", "delivery"].map((phase) => [
          phase,
          { cpu: 1, memoryMiB: 100 },
        ]),
      ),
    },
  };
  const state = {
    work: Object.fromEntries(
      ["a", "b", "c"].map((id) => [id, { status: "running" }]),
    ),
  };
  let cancelled = false;
  const phases = phaseAdmission(
    config,
    state,
    () => {},
    () => cancelled,
  );
  return {
    config,
    state,
    phases,
    cancel: () => {
      cancelled = true;
    },
  };
}

test("phase reservations transfer at concurrency one without retaining a coding slot", async () => {
  const { state, phases } = fixture(1);
  await phases.reserve("a", "coding");
  assert.equal(phases.reason("b", "coding"), "cpu ceiling");
  await phases.reserve("a", "validation");
  assert.equal(phases.codingCount(), 0);
  await phases.reserve("a", "review");
  assert.equal(state.work.a.phaseReservation, "review");
  phases.release("a");
  await phases.reserve("b", "coding");
  assert.equal(phases.codingCount(), 1);
});

test("a waiting completion receives the next suitable grant before more coding", async () => {
  const { state, phases } = fixture(1);
  await phases.reserve("a", "coding");
  const review = phases.reserve("b", "review");
  assert.equal(state.work.b.requestedPhase, "review");
  phases.release("a");
  assert.equal(phases.reason("c", "coding"), "completion phase waiting");
  await review;
  assert.equal(state.work.b.phaseReservation, "review");
  phases.release("b");
});

test("unknown reservations and exhausted ceilings fail closed; cancellation releases no uncertain reservation", async () => {
  const { config, state, phases, cancel } = fixture(1);
  delete config.scheduling.phases.review.cpu;
  await assert.rejects(phases.reserve("b", "review"), /unknown/);
  delete state.work.b.requestedPhase;
  await phases.reserve("a", "coding");
  const waiting = phases.reserve("c", "validation");
  cancel();
  await assert.rejects(waiting, /cancelled/);
  assert.equal(state.work.a.phaseReservation, "coding");
  assert.equal(state.work.c.phaseReservation, undefined);
});

test("restart consumes persisted reservations and admission worker ceilings", async () => {
  const { config, state } = fixture(3);
  state.work.a.phaseReservation = "coding";
  state.admission = { authority: { resources: { maxConcurrency: 1 } } };
  const restarted = phaseAdmission(
    config,
    state,
    () => {},
    () => false,
  );
  assert.equal(restarted.reason("b", "coding"), "coding concurrency ceiling");
  await restarted.reserve("a", "validation");
  await restarted.reserve("b", "coding");
  assert.equal(restarted.codingCount(), 1);
});

test("eligible pending priority, prerequisites and stable order retain ownership constraints", () => {
  const item = (id, priority = 0, dependencies = []) => ({
    id,
    priority,
    dependencies,
    ownedPaths: [`${id}.txt`],
    resources: [],
  });
  const graph = {
    items: [
      item("plain"),
      item("prerequisite"),
      item("join", 100, ["prerequisite"]),
      item("urgent", 2),
      item("peer", 2),
    ],
  };
  const work = Object.fromEntries(
    graph.items.map((item) => [item.id, { status: "pending" }]),
  );
  assert.deepEqual(
    readyItems(graph, work, new Set(), 9).map((item) => item.id),
    ["urgent", "peer", "prerequisite", "plain"],
  );
  graph.items[0].priority = 3;
  assert.equal(readyItems(graph, work, new Set(), 1)[0].id, "plain");
  graph.items[0].ownedPaths = ["urgent.txt"];
  assert.equal(readyItems(graph, work, new Set(["urgent"]), 1)[0].id, "peer");
});

test("remaining provider slots compose with operator ceilings without subtracting workers twice", async () => {
  const { phases } = fixture(3);
  await phases.reserve("a", "coding");
  assert.equal(phases.availableSlots(2), 2);
  assert.equal(phases.availableSlots(1), 1);
  assert.equal(phases.availableSlots(0), 0);
  assert.equal(phases.availableSlots("unknown"), 2);
  assert.throws(() => phases.availableSlots(-1), /availableSlots/);
  assert.throws(() => phases.availableSlots(Number.NaN), /availableSlots/);
});

test("memory is a binding independent resource and deadlines stop waiting admission", async () => {
  const { config, state, phases } = fixture(3);
  config.scheduling.memoryMiB = 100;
  await phases.reserve("a", "coding");
  assert.equal(phases.reason("b", "review"), "memoryMiB ceiling");
  state.coordinator = { deadlineAt: new Date(Date.now() - 1).toISOString() };
  await assert.rejects(phases.reserve("b", "review"), /deadline/);
  assert.equal(state.work.a.phaseReservation, "coding");
});

test("ready read-only QA gets the next suitable opportunity without preempting coding", () => {
  const graph = {
    items: [
      {
        id: "coding",
        priority: 100,
        dependencies: [],
        ownedPaths: ["coding.txt"],
      },
      { id: "qa", kind: "qa", dependencies: ["done"], ownedPaths: [] },
      { id: "done", dependencies: [], ownedPaths: ["done.txt"] },
    ],
  };
  const work = {
    coding: { status: "pending" },
    qa: { status: "pending" },
    done: { status: "done" },
  };
  assert.equal(readyItems(graph, work, new Set(), 1)[0].id, "qa");
  work.coding.status = "running";
  assert.equal(readyItems(graph, work, new Set(["coding"]), 1)[0].id, "qa");
  assert.equal(work.coding.status, "running");
});
