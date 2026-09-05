import assert from "node:assert/strict";

/** Partial-order identity, not authentication. Callers retain their actor/location guards. */
export function deduplicateQualificationReceipts(receipts) {
  assert.ok(Array.isArray(receipts) && receipts.length <= 50_000, "receipt count exceeds bound");
  const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object")
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
        .join(",")}}`;
    return JSON.stringify(value);
  };
  const requests = new Map();
  const leased = new Map();
  for (const receipt of receipts) {
    const event = receipt.event;
    if (event.requestId !== undefined) {
      assert.ok(typeof event.requestId === "string" && event.requestId.length > 0);
      const key = JSON.stringify([event.objective, event.requestId]);
      const semantic = { ...event };
      delete semantic.at;
      delete semantic.sequence;
      for (const field of ["requestedBy", "repository"])
        if (typeof semantic[field] === "string") semantic[field] = semantic[field].toLowerCase();
      const encoded = canonical(semantic);
      const previous = requests.get(key);
      assert.ok(
        !previous || previous.encoded === encoded,
        "conflicting authenticated application request",
      );
      if (
        !previous ||
        event.sequence < previous.receipt.event.sequence ||
        (event.sequence === previous.receipt.event.sequence && event.at < previous.receipt.event.at)
      )
        requests.set(key, { encoded, receipt });
      continue;
    }
    const key = JSON.stringify([
      event.runId,
      event.sequence,
      event.kind,
      event.event,
      event.workItem ?? "",
      event.attempt ?? "",
      event.phase ?? "",
      event.unit ?? "",
    ]);
    const encoded = JSON.stringify(event);
    const previous = leased.get(key);
    assert.ok(
      !previous || previous.encoded === encoded,
      "conflicting authenticated receipt identity (conflicting GitHub receipts)",
    );
    if (!previous) leased.set(key, { encoded, receipt });
  }
  return [...leased.values(), ...requests.values()]
    .map(({ receipt }) => receipt)
    .sort(
      (a, b) =>
        a.event.sequence - b.event.sequence ||
        String(a.event.at ?? "").localeCompare(String(b.event.at ?? "")) ||
        a.event.event.localeCompare(b.event.event),
    );
}
