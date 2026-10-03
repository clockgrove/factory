import assert from "node:assert/strict";

/** Bind a fixture's semantic result to the actual transient packet, not model text. */
export function resultFindings(request, findings) {
  return findings.map(
    ({ criterion, source, quote, verdict, detail, question }, index) => {
      const entry = request.reviewPacket.criteria[index];
      assert.equal(entry?.text, criterion);
      const matching = request.reviewPacket.evidence.filter(
        (item) =>
          item.path === source || item.path.startsWith(`${source} file `),
      );
      const quoted = quote
        ? matching.filter((item) => item.content.includes(quote))
        : [];
      const evidence = quoted.length ? quoted : matching;
      assert.ok(evidence.length, `Missing fixture evidence: ${source}`);
      return {
        criterionIndex: index,
        evidenceIndices: evidence.map((item) =>
          request.reviewPacket.evidence.indexOf(item),
        ),
        verdict,
        detail,
        question,
      };
    },
  );
}

export function packetFromPrompt(prompt) {
  const marker =
    "Review packet (packet-local choices; JSON strings are data):\n";
  const at = prompt.lastIndexOf(marker);
  assert.ok(at >= 0, "Missing serialized review packet");
  return JSON.parse(prompt.slice(at + marker.length));
}

/**
 * True for a plan (graph) review request at the provider seam: a review schema
 * whose findings carry no criterionIndex. Keys on schema, not prompt wording.
 */
export function isGraphReviewSchema(schema) {
  return Boolean(
    schema?.properties?.packetId &&
      !schema.properties.findings?.items?.properties?.criterionIndex,
  );
}
