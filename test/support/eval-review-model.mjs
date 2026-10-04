/**
 * Credential-free `--planning-model` for review-only evals. It flags a plan
 * only when its graph shows a merge assumption, an invented check name or a
 * worker-written test, so per-defect recall differs by defect. A finding
 * names the offending item or check when it can, as a reviewer would.
 */
const FLAG = /merged into main|has merged|build-and-test|new unit tests/;

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
      const item = request.graph.items.find((entry) =>
        FLAG.test(JSON.stringify(entry)),
      );
      const gate = (request.graph.requiredPreIntegrationChecks ?? []).find(
        (entry) => FLAG.test(entry.checkName),
      );
      const subject = item
        ? `Item ${item.id}`
        : gate
          ? `Check ${gate.checkName}`
          : null;
      return {
        packetId: request.reviewPacket.id,
        findings: subject
          ? [
              {
                evidenceIndices: [0],
                detail: `${subject} assumes a merge or an unsupported check.`,
                question: "Fix the plan?",
              },
            ]
          : [],
      };
    },
  };
}
