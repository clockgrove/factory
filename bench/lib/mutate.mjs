/**
 * The auto-grader's mutation pass (bench/lib/grade-auto.mjs, #2275): Factory's
 * own rule-based mutants (src/review/mutants.ts), so the grader scores a
 * change's tests with the mutants its result review saw. Here each mutant
 * runs the repository's test commands in a scratch checkout with the
 * harness's own runner (grade.mjs runCommand), not Factory's sandbox.
 */
import {
  chooseMutants,
  runMutants as runFactoryMutants,
} from "../../dist/review/mutants.js";
import { runCommand } from "./grade.mjs";

export { chooseMutants };

/**
 * Run `mutants` in `tree` against the `tests` commands, with `env` and the
 * process `groups` the harness tracks: `{ status, results, command }` as
 * Factory's runMutants answers.
 */
export function runMutants(tree, mutants, { tests, env, deadline, groups }) {
  return runFactoryMutants(tree, mutants, {
    tests,
    deadline,
    run: async (command, timeoutMs) => {
      const step = await runCommand(command, {
        cwd: tree,
        env,
        timeoutMs,
        groups,
      });
      return { exitCode: step.code, timedOut: step.timedOut };
    },
  });
}
