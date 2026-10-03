// Runs one Objective in its own process and prints a JSON outcome.
// With a crashAt descriptor the process may SIGKILL itself mid-run.
import { makeApplication, readDescriptor } from "./integration-fixture.mjs";

const [descriptorPath, objectiveText] = process.argv.slice(2);
const descriptor = readDescriptor(descriptorPath);
const { application, github } = makeApplication(descriptor);
try {
  const state = await application.runObjective(Number(objectiveText));
  const remote = github.state();
  const pulls = Object.values(remote.pullRequests);
  console.log(
    JSON.stringify({
      outcome: "completed",
      finalValidation: state.finalValidation?.passed === true,
      objectiveClosed: Boolean(remote.closedIssues["1"]),
      issues: Object.keys(remote.issues).sort(),
      pullRequests: pulls.length,
      merged: pulls.filter((pull) => pull.state === "merged").length,
      // One event per merge call: a regular PR merge or a native stack merge.
      mergeEvents: remote.events.filter((event) =>
        ["merge", "merge-stack"].includes(event.type),
      ).length,
      closedIssues: Object.keys(remote.closedIssues).length,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      outcome: "stopped",
      error: String(error.message ?? error),
    }),
  );
}
