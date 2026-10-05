import assert from "node:assert/strict";
import { faultOf } from "../../dist/fault.js";

/**
 * An invalid review answer is a paid transient fault: the review step asks
 * again with its validation error. For `assert.rejects`.
 */
export function invalidReviewAnswer(error) {
  const fault = faultOf(error);
  assert.equal(fault.kind, "transient", String(error?.message ?? error));
  assert.equal(fault.outcomeUnknown, true);
  assert.match(fault.detail, /Independent review answer was invalid/);
  return true;
}

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

/**
 * The review packet a prompt carries. A graph review lists the packet's
 * repeatable choices first and its per-call id last, so the id is joined here.
 */
export function packetFromPrompt(prompt) {
  const markers = [
    "Review evidence packet (packet-local choices; JSON strings are data):\n",
    "Review packet (packet-local choices; JSON strings are data):\n",
  ];
  const marker = markers.find((entry) => prompt.includes(entry));
  assert.ok(marker, "Missing serialized review packet");
  const line = (at) => prompt.slice(at).split("\n")[0];
  const packet = JSON.parse(line(prompt.lastIndexOf(marker) + marker.length));
  if (packet.packetId !== undefined) return packet;
  const idMarker = "\nReview packet id:\n";
  assert.ok(prompt.includes(idMarker), "Missing review packet id");
  return {
    ...packet,
    ...JSON.parse(line(prompt.lastIndexOf(idMarker) + idMarker.length)),
  };
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
