/** Encode canonical fixture coverage only at the scripted Codex transport boundary. */
export function encodeCodexReadiness(input) {
  const graph = structuredClone(input);
  for (const coverage of graph.coverage ?? []) {
    const { probe, ...environment } = coverage.environment;
    const owner = graph.items.find((item) => item.id === coverage.itemId);
    const index = probe
      ? owner.validation.findIndex((entry) => entry.command === probe)
      : null;
    if (index === -1)
      throw new Error("Fixture readiness probe lacks owner validation");
    coverage.environment = { ...environment, probeValidationIndex: index };
  }
  return graph;
}
