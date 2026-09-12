/** Shared private qualification evidence size and credential boundary. */
import assert from "node:assert/strict";

export const MAX_ORDINARY_QUALIFICATION_EVIDENCE_BYTES = 8 * 1024 * 1024;
export const MAX_LARGE_FILE_REFUSAL_EVIDENCE_BYTES = 16 * 1024 * 1024;

const suspectedCredential =
  /\b(?:gh[opurs]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|authorization\s*:\s*(?:bearer|basic)\s+\S+/i;

function serialized(value, space) {
  const text = JSON.stringify(value, null, space);
  assert.notEqual(text, undefined, "qualification evidence is not serializable");
  return text;
}

export function assertQualificationEvidenceValue(
  value,
  maximum = 4 * 1024 * 1024,
  label = "qualification evidence",
) {
  const text = serialized(value);
  assert.ok(Buffer.byteLength(text) <= maximum, `${label} exceeds bound`);
  assert.ok(!suspectedCredential.test(text), `${label} contains suspected credential material`);
  return value;
}

/** Validate the component in the same wrapper and indentation used by the persisted envelope. */
export function largeFileRefusalEvidenceBytes(value, redact = "") {
  const raw = serialized({ largeFileRefusal: value }, 2);
  assert.ok(
    Buffer.byteLength(raw) <= MAX_LARGE_FILE_REFUSAL_EVIDENCE_BYTES,
    "refusal evidence exceeds bound",
  );
  assert.ok(
    !suspectedCredential.test(raw),
    "refusal evidence contains suspected credential material",
  );
  const persisted = redact ? raw.replaceAll(redact, "[REDACTED]") : raw;
  const bytes = Buffer.byteLength(persisted);
  assert.ok(
    bytes <= MAX_LARGE_FILE_REFUSAL_EVIDENCE_BYTES,
    "persisted refusal evidence exceeds bound",
  );
  return bytes;
}

/** Return the already-redacted text only after every persisted component fits its exact cap. */
export function boundedQualificationEvidenceText(
  evidence,
  redact,
  { allowLargeFileRefusal = false } = {},
) {
  assert.ok(evidence && typeof evidence === "object" && !Array.isArray(evidence));
  assert.ok(typeof redact === "string" && redact.length > 0, "evidence redaction value missing");
  const raw = serialized(evidence, 2);
  const text = raw.replaceAll(redact, "[REDACTED]");
  const { largeFileRefusal, ...ordinaryEvidence } = evidence;
  const ordinaryText = serialized(ordinaryEvidence, 2).replaceAll(redact, "[REDACTED]");
  const ordinaryBytes = Buffer.byteLength(ordinaryText);
  assert.ok(
    ordinaryBytes <= MAX_ORDINARY_QUALIFICATION_EVIDENCE_BYTES,
    "ordinary qualification evidence exceeds bound",
  );
  if (largeFileRefusal === undefined) {
    assert.ok(
      Buffer.byteLength(`${text}\n`) <= MAX_ORDINARY_QUALIFICATION_EVIDENCE_BYTES,
      "qualification evidence exceeds bound",
    );
    return text;
  }
  assert.equal(
    allowLargeFileRefusal,
    true,
    "large-file refusal evidence is not authorized for this qualification extension",
  );
  const refusalBytes = largeFileRefusalEvidenceBytes(largeFileRefusal, redact);
  // The two standalone pretty-printed object envelopes contain at least the
  // separators retained when their properties are combined into one object.
  assert.ok(
    Buffer.byteLength(text) <= ordinaryBytes + refusalBytes,
    "combined qualification evidence exceeds component bounds",
  );
  assert.ok(
    Buffer.byteLength(`${text}\n`) <=
      MAX_ORDINARY_QUALIFICATION_EVIDENCE_BYTES + MAX_LARGE_FILE_REFUSAL_EVIDENCE_BYTES,
    "complete persisted qualification evidence exceeds bound",
  );
  return text;
}
