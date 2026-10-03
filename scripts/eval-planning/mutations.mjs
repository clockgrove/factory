// Seeded plan defects. Each one injects exactly one planning rule violation
// into a known-good authored plan, so review recall can be measured per rule.
// Authored plans name coverage criteria by index (`criterion`); see
// evals/review/*/fixture.json.

import { requiredCommandLine } from "./metrics.mjs";

const isWork = (item) => !item.kind || item.kind === "work";
const clone = (value) => structuredClone(value);

function dropValidation(graph, item, index) {
  const [removed] = item.validation.splice(index, 1);
  for (const entry of graph.coverage)
    if (
      entry.itemId === item.id &&
      "validationIndex" in entry.proof &&
      entry.proof.validationIndex > index
    )
      entry.proof.validationIndex -= 1;
  return removed;
}

/** Each defect returns null when the plan has nothing it can apply to. */
export const DEFECTS = [
  {
    id: "invented-ci-name",
    rule: "A required CI check name must appear verbatim in a source.",
    apply(input, context) {
      const graph = clone(input);
      const gate = graph.requiredPreIntegrationChecks?.[0];
      const proof = graph.coverage.find((entry) => "checkName" in entry.proof);
      const old = gate?.checkName ?? proof?.proof.checkName;
      if (!old) return null;
      const candidates = ["ci / build-and-test", "build-and-test (ubuntu)"];
      for (let n = 2; candidates.length < 50; n += 1)
        candidates.push(`ci / build-and-test-${n}`);
      const name = candidates.find(
        (candidate) => !context.sourceText.includes(candidate),
      );
      if (!name) return null;
      if (gate) gate.checkName = name;
      for (const entry of graph.coverage)
        if (entry.proof.checkName === old) entry.proof.checkName = name;
      return { graph, itemId: null };
    },
  },
  {
    id: "acceptance-needs-own-merge",
    rule: "An item's own merge, upload, publication or hydration happens after its acceptance.",
    apply(input) {
      const graph = clone(input);
      const item =
        graph.items.find(
          (candidate) =>
            isWork(candidate) && candidate.expectedOutputRoles?.length,
        ) ?? graph.items.find(isWork);
      if (!item) return null;
      item.acceptance.push(
        item.expectedOutputRoles?.length
          ? "The selected files are uploaded to Git LFS, merged into main, and hydrate in a fresh clone."
          : "This item's pull request is merged into main and the main-branch CI run is green.",
      );
      return { graph, itemId: item.id };
    },
  },
  {
    id: "native-dependency-assumed-merged",
    rule: "A native-stack dependency is published but not merged when its dependent starts.",
    apply(input, context) {
      if (!context.native) return null;
      const graph = clone(input);
      const item = graph.items.find(
        (candidate) =>
          isWork(candidate) &&
          candidate.dependencies.some((id) =>
            graph.items.some((other) => other.id === id && isWork(other)),
          ),
      );
      if (!item) return null;
      const dependency = item.dependencies[0];
      item.brief += ` Start from main after \`${dependency}\` has merged, and take its code from main.`;
      item.acceptance.push(
        `\`${dependency}\` is merged into main before this item starts, and this item builds on main.`,
      );
      return { graph, itemId: item.id };
    },
  },
  {
    id: "final-review-replaces-command",
    rule: "Final review cannot replace a command an Objective criterion requires.",
    apply(input, context) {
      const graph = clone(input);
      // Only a criterion that is exactly one command line, not a Final
      // validation command, and proved by running that command.
      const entry = graph.coverage.find((candidate) => {
        const command =
          context.isCommand &&
          requiredCommandLine(
            context.criteria?.[candidate.criterion] ?? "",
            context.finalCommands ?? [],
            context.isCommand,
          );
        const item = graph.items.find((other) => other.id === candidate.itemId);
        return (
          command &&
          item &&
          isWork(item) &&
          candidate.proof.kind === "result-command" &&
          item.validation[candidate.proof.validationIndex]?.command === command
        );
      });
      if (!entry) return null;
      const item = graph.items.find(
        (candidate) => candidate.id === entry.itemId,
      );
      dropValidation(graph, item, entry.proof.validationIndex);
      entry.proof = { kind: "final-review" };
      return {
        graph,
        itemId: item.id,
      };
    },
  },
  {
    id: "missing-ownership",
    rule: "Every file the work creates or changes has exactly one owner.",
    apply(input) {
      const graph = clone(input);
      const item = graph.items.find(
        (candidate) => isWork(candidate) && candidate.ownedPaths.length > 1,
      );
      if (!item) return null;
      const path =
        [...item.ownedPaths]
          .reverse()
          .find((candidate) => item.brief.includes(candidate)) ??
        item.ownedPaths.at(-1);
      item.ownedPaths = item.ownedPaths.filter((owned) => owned !== path);
      return { graph, itemId: item.id };
    },
  },
  {
    id: "missing-dependency",
    rule: "An item that needs another item's output depends on it.",
    apply(input) {
      const graph = clone(input);
      const item = graph.items.find(
        (candidate) =>
          isWork(candidate) &&
          candidate.dependencies.some((id) =>
            graph.items.some((other) => other.id === id && isWork(other)),
          ),
      );
      if (!item) return null;
      const dependency = item.dependencies.find((id) =>
        graph.items.some((other) => other.id === id && isWork(other)),
      );
      item.dependencies = item.dependencies.filter((id) => id !== dependency);
      return { graph, itemId: item.id };
    },
  },
  {
    id: "worker-test-only-proof",
    rule: "A test the same item writes is not the only proof of a source-required behavior.",
    apply(input, context) {
      if (!context.workerTest) return null;
      const graph = clone(input);
      // A behavior the good plan leaves to independent result review becomes
      // proved only by the item's own new tests. Every command stays.
      const entry = graph.coverage.find((candidate) => {
        const item = graph.items.find((other) => other.id === candidate.itemId);
        return (
          item && isWork(item) && candidate.proof.kind === "result-semantic"
        );
      });
      if (!entry) return null;
      const item = graph.items.find(
        (candidate) => candidate.id === entry.itemId,
      );
      const testPath = `${context.workerTest.directory}${item.id}.test.mjs`;
      let index = item.validation.findIndex(
        (check) => check.command === context.workerTest.command,
      );
      if (index < 0) {
        item.validation.push({
          command: context.workerTest.command,
          provenance: context.workerTest.provenance,
          source: context.workerTest.source,
        });
        index = item.validation.length - 1;
      }
      entry.proof = { kind: "result-command", validationIndex: index };
      if (!item.ownedPaths.includes(testPath)) item.ownedPaths.push(testPath);
      item.brief += ` Prove the behavior with new unit tests in \`${testPath}\`.`;
      return { graph, itemId: item.id };
    },
  },
];

/** The known-good plan plus one variant per applicable defect. */
export function planVariants(graph, context) {
  return [
    { variant: "good", defect: null, graph: clone(graph) },
    ...DEFECTS.flatMap((defect) => {
      const mutated = defect.apply(graph, context);
      return mutated
        ? [
            {
              variant: defect.id,
              defect: defect.id,
              rule: defect.rule,
              ...mutated,
            },
          ]
        : [];
    }),
  ];
}
