import { describe } from "node:test";
import { runScenario } from "./support/fault-harness.mjs";
import {
  declareScenario,
  referenceRun,
  scenarioConcurrency,
} from "./support/fault-matrix.mjs";

// Multi-fault bound cases (#589): for every paid step the fault suites can
// reach, fault the paid call until its bound (three transient faults; the
// fourth is a decision), then answer the stop with the command the status
// names and require the Objective to converge to the end state of an
// uninterrupted run. A single fault never reaches a bound, so the matrix
// alone cannot show that the decision is reachable and answerable.
//
// Not covered here: diagnose and amend, which an uninterrupted run never
// reaches (test/bounded-repairs.test.mjs and test/graph-amendments.test.mjs
// drive them).

const BOTH = ["regular", "native-stack"];
const LOST = 4;
const OBJECTIVE_ANSWER = "factory retry --objective 1";
const itemAnswer = (item) => `factory retry --objective 1 --item ${item}`;

/** The nth call of a method in the reference's first run (1-based). */
function occurrenceOf(reference, method, matches) {
  const calls = reference.calls.filter(
    (call) =>
      call.run === 0 && call.target === "model" && call.method === method,
  );
  const index = calls.findIndex(matches);
  if (index < 0)
    throw new Error(`The uninterrupted run makes no matching ${method} call`);
  return { occurrence: index + 1, call: calls[index] };
}

/**
 * A paid model call faulted `LOST` times in a row from its first occurrence:
 * its response lost, or (`invalid`) answered in a shape the decoder refuses.
 */
function lostModelCalls(
  reference,
  method,
  matches = () => true,
  kind = "lost",
) {
  const { occurrence, call } = occurrenceOf(reference, method, matches);
  return {
    inProcess: [{ target: "model", method, occurrence, times: LOST, kind }],
    call: {
      target: "model",
      method,
      kind,
      ...(call.phase !== undefined && { phase: call.phase }),
      ...(call.item !== undefined && { item: call.item }),
    },
  };
}

const CASES = [
  {
    name: "plan: the planner's response is lost four times",
    build: (reference) => ({
      ...lostModelCalls(reference, "generateStructured"),
      answer: OBJECTIVE_ANSWER,
    }),
  },
  {
    name: "plan review: the reviewer's response is lost four times",
    build: (reference) => ({
      ...lostModelCalls(reference, "reviewGraph"),
      answer: OBJECTIVE_ANSWER,
    }),
  },
  {
    // Only the plan step bounds it (#644): no second counter re-asks first.
    name: "plan review: the reviewer's answer is undecodable four times",
    build: (reference) => ({
      ...lostModelCalls(reference, "reviewGraph", () => true, "invalid"),
      answer: OBJECTIVE_ANSWER,
    }),
  },
  {
    name: "result review: alpha's review response is lost four times",
    build: (reference) => ({
      ...lostModelCalls(
        reference,
        "reviewResult",
        (call) => call.phase !== "objective-review",
      ),
      item: "alpha",
      answer: itemAnswer("alpha"),
    }),
  },
  {
    name: "final review: the Objective review response is lost four times",
    build: (reference) => ({
      ...lostModelCalls(
        reference,
        "reviewResult",
        (call) => call.phase === "objective-review",
      ),
      answer: OBJECTIVE_ANSWER,
    }),
  },
  {
    // An invalid answer was paid for: it counts toward the bound (#634).
    name: "final review: the Objective review answer is undecodable four times",
    build: (reference) => ({
      ...lostModelCalls(
        reference,
        "reviewResult",
        (call) => call.phase === "objective-review",
        "invalid",
      ),
      answer: OBJECTIVE_ANSWER,
    }),
  },
  {
    // Each death is a paid fault the driver confirmed (ctx.paidLost).
    name: "execute: alpha's worker ends without a result four times",
    build: () => ({
      actions: { alpha: { dieAttempts: LOST } },
      worker: "alpha",
      item: "alpha",
      answer: itemAnswer("alpha"),
    }),
  },
];

const references = Object.fromEntries(
  await Promise.all(
    BOTH.map(async (delivery) => [delivery, await referenceRun(delivery)]),
  ),
);

describe("paid-step bounds answered by the named command", {
  concurrency: scenarioConcurrency(),
}, () => {
  for (const [index, testCase] of CASES.entries())
    for (const delivery of BOTH) {
      const built = testCase.build(references[delivery]);
      declareScenario(
        `${delivery}: ${testCase.name}`,
        () =>
          runScenario({
            name: `b${index}-${delivery === "regular" ? "r" : "n"}`,
            delivery,
            inProcess: built.inProcess ?? [],
            actions: built.actions ?? {},
            answer: true,
            // The bound stop, then the answered run.
            maxRestarts: 2,
          }),
        {
          checks: ["bound", "end"],
          bound: {
            calls: LOST,
            answer: built.answer,
            ...(built.call && { call: built.call }),
            ...(built.worker && { worker: built.worker }),
            ...(built.item && { item: built.item }),
          },
        },
        {},
      );
    }
});
