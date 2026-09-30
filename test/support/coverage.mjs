/** Legacy fixture graphs use final semantic review; QA behavior has dedicated fixtures. */
export function withCoverage(request, input) {
  const graph = structuredClone(input);
  for (const item of graph.items) item.kind ??= "work";
  graph.coverage ??= (request.coverageObligations ?? []).map((obligation) => ({
    criterionId: obligation.criterionId,
    itemId: graph.items[0].id,
    proof: { kind: "final-review" },
    environment: {
      kind: "local",
      readiness: "available",
      probe: "",
      preparedBy: "",
    },
  }));
  return graph;
}
