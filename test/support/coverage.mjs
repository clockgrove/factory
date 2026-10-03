/**
 * Legacy fixture graphs use final semantic review, except that an obligation
 * naming a planned command is proved by that command. QA behavior has
 * dedicated fixtures.
 */
export function withCoverage(request, input) {
  const graph = structuredClone(input);
  for (const item of graph.items) item.kind ??= "work";
  const commandProof = (text) => {
    for (const command of [
      ...[...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]),
      text.trim(),
    ])
      for (const item of graph.items) {
        const validationIndex = item.validation.findIndex(
          (check) => check.command === command,
        );
        if (validationIndex >= 0)
          return {
            itemId: item.id,
            proof: {
              kind:
                item.kind === "qa" ? "integrated-command" : "result-command",
              validationIndex,
            },
          };
      }
    return undefined;
  };
  graph.coverage ??= (request.coverageObligations ?? []).map((obligation) => ({
    criterionId: obligation.criterionId,
    ...(commandProof(obligation.source.text) ?? {
      itemId: graph.items[0].id,
      proof: { kind: "final-review" },
    }),
    environment: {
      kind: "local",
      readiness: "available",
      probe: "",
      preparedBy: "",
    },
  }));
  return graph;
}
