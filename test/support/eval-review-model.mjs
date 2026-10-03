/**
 * Credential-free `--planning-model` for review-only evals. It flags a plan
 * only when its graph text shows a merge assumption, an invented check name
 * or a worker-written test, so per-defect recall differs by defect.
 */
export function createPlanningModel() {
  return {
    async generateStructured() {
      throw new Error("The review eval model does not plan");
    },
    async reviewGraph(request) {
      request.invocation?.observe?.({
        invocationId: request.invocation.invocationId,
        phase: request.invocation.phase,
        ordinal: request.invocation.ordinal,
        type: "completed",
        usageAvailable: true,
        usage: { inputTokens: 100, outputTokens: 10 },
      });
      const text = JSON.stringify(request.graph);
      const flagged =
        /merged into main|has merged|build-and-test|new unit tests/.test(text);
      return {
        packetId: request.reviewPacket.id,
        findings: flagged
          ? [
              {
                evidenceIndices: [0],
                detail: "The plan assumes a merge or an unsupported check.",
                question: "Fix the plan?",
              },
            ]
          : [],
      };
    },
  };
}
