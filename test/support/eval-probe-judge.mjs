import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { JUDGE_DIMENSIONS } from "../../scripts/eval-planning/judge.mjs";

function plans(directory) {
  if (!directory || !existsSync(directory)) return 0;
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true }))
    if (entry.isDirectory()) count += plans(join(directory, entry.name));
    else if (entry.name === "plan.json") count += 1;
  return count;
}

/**
 * `--judge-transport` that reports what a judge process can see: its working
 * directory, CODEX_HOME, run-directory environment and any plan on disk.
 */
export function createJudgeTransport() {
  return {
    async run({ turn }) {
      const probe = {
        cwd: readdirSync(process.cwd()).sort(),
        codexHome: readdirSync(process.env.CODEX_HOME).sort(),
        xdgState: process.env.XDG_STATE_HOME ?? null,
        plans: plans(process.env.FACTORY_EVAL_PROBE_ROOT),
      };
      turn.ended = true;
      turn.response = JSON.stringify({
        dimensions: JUDGE_DIMENSIONS.map((name) => ({
          name,
          verdict: "pass",
          evidence: JSON.stringify(probe),
        })),
      });
    },
  };
}
