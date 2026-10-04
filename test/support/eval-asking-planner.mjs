/**
 * Credential-free `--planning-model` whose planning stops for an operator: the
 * compile returns a graph that fails validation, and the diagnosis says the
 * Objective needs an operator decision.
 */
export function createPlanningModel() {
  return {
    async generateStructured(request) {
      if (request.purpose === "diagnosis")
        return {
          kind: "operator",
          diagnosis:
            "Publishing to the npm registry needs a token and authority",
          correction: "",
        };
      return {
        objective: request.compileContext.objectiveNumber,
        baseSha: request.baseSha,
        items: [],
      };
    },
    async reviewGraph() {
      throw new Error("The asking planner never reaches review");
    },
  };
}
