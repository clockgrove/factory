import { JUDGE_DIMENSIONS } from "../../scripts/eval-planning/judge.mjs";

/**
 * Credential-free `--judge-transport`. Judges disagree on purpose:
 * - a Claude judge fails `dependencies` when no Work Item depends on another;
 * - a Codex judge fails `scope` when the plan has a read-only QA item.
 */
export function createJudgeTransport({ judge }) {
  return {
    async run({ prompt, turn }) {
      const input = JSON.parse(prompt.slice(prompt.indexOf("\n{") + 1));
      const items = input.plan.items;
      const failing =
        judge.model.kind === "claude-agent-sdk"
          ? items.some((item) => item.dependencies.length)
            ? null
            : "dependencies"
          : items.some((item) => item.kind === "qa")
            ? "scope"
            : null;
      turn.usage = { inputTokens: 500, outputTokens: 50 };
      turn.ended = true;
      turn.response = JSON.stringify({
        dimensions: JUDGE_DIMENSIONS.map((name) => ({
          name,
          verdict: name === failing ? "fail" : "pass",
          evidence: `scripted ${name}`,
        })),
      });
    },
  };
}
