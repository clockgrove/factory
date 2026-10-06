/** A declared actionable answer for fixtures whose failure is an owned implementation defect. */
export function diagnosisInput(request) {
  return JSON.parse(
    request.objective.slice(request.objective.lastIndexOf("\n{") + 1),
  );
}
export function actionableDiagnosis(request, answer = {}) {
  const input = diagnosisInput(request);
  return {
    decision: "repair",
    diagnosis: "The owned implementation is incomplete",
    correction: "Implement the owned result from the accepted base",
    predecessor: "",
    path: input.item.ownedPaths[0],
    readiness: "actionable",
    prerequisites: [],
    question: "",
    evidenceIndices: input.repairEvidence.map((_, index) => index),
    commandAssessments: (
      input.repairEvidence[1].record?.evidence.commands ?? []
    )
      .filter((command) => !command.passed)
      .map((command) => ({
        commandIndex: command.index,
        disposition: "owned-change",
      })),
    ...answer,
  };
}
