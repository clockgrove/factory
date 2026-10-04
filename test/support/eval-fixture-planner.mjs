import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { hydrateAuthoredGraph } from "../../scripts/eval-planning/review.mjs";

const review = resolve(import.meta.dirname, "../../evals/review");

/**
 * Credential-free `--planning-model` for plan-mode evals: a case plans to the
 * known-good graph of the review fixture built on it, and review is clean.
 */
export function createPlanningModel({ directory }) {
  const { name } = JSON.parse(
    readFileSync(join(directory, "spec.json"), "utf8"),
  );
  const fixture = readdirSync(review)
    .map((entry) => join(review, entry, "fixture.json"))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, spec: JSON.parse(readFileSync(path, "utf8")) }))
    .find(({ spec }) => basename(spec.case) === name);
  const observe = (request) =>
    request.invocation?.observe?.({
      invocationId: request.invocation.invocationId,
      phase: request.invocation.phase,
      ordinal: request.invocation.ordinal,
      type: "completed",
      usageAvailable: true,
      usage: { inputTokens: 1000, outputTokens: 100 },
    });
  return {
    async generateStructured(request) {
      observe(request);
      if (!fixture) throw new Error(`No fixture plan for case ${name}`);
      return hydrateAuthoredGraph(fixture.spec.graph, request);
    },
    async reviewGraph(request) {
      observe(request);
      return { packetId: request.reviewPacket.id, findings: [] };
    },
  };
}
