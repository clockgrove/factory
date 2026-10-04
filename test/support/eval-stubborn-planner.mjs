/**
 * Credential-free `--planning-model` whose corrections never validate: every
 * compile returns a graph that fails validation, and the diagnosis keeps
 * proposing a correction that the next compile ignores. Planning stops without
 * a reviewed graph, which the eval must count as a question, not an error.
 */
export function createPlanningModel() {
  return {
    async generateStructured(request) {
      if (request.purpose === "diagnosis")
        return {
          kind: "planning-output",
          diagnosis: "The graph has no work items",
          correction: "Add at least one work item",
        };
      return {
        objective: request.compileContext.objectiveNumber,
        baseSha: request.baseSha,
        items: [],
      };
    },
    async reviewGraph() {
      throw new Error("The stubborn planner never reaches review");
    },
  };
}
