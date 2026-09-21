/** Safe, machine-readable violations for deterministic qualification boundaries. */

const textPattern = /^[\x20-\x7e]{1,240}$/;
const keyPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
const codePattern = /^[a-z][a-z0-9-]{2,79}$/;

function safeValue(value, depth = 0) {
  if (depth > 3) throw new TypeError("qualification diagnostic nesting exceeds bound");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && textPattern.test(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 16) throw new TypeError("qualification diagnostic array exceeds bound");
    return value.map((entry) => safeValue(entry, depth + 1));
  }
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    if (entries.length > 16) throw new TypeError("qualification diagnostic object exceeds bound");
    return Object.fromEntries(
      entries.map(([key, entry]) => {
        if (!keyPattern.test(key)) throw new TypeError("qualification diagnostic field is invalid");
        return [key, safeValue(entry, depth + 1)];
      }),
    );
  }
  throw new TypeError("qualification diagnostic value is invalid");
}

function violation(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype)
    throw new TypeError("qualification violation must be an object");
  if (!codePattern.test(input.code ?? ""))
    throw new TypeError("qualification violation code is invalid");
  for (const field of ["phase", "item", "field", "expected"])
    if (!textPattern.test(input[field] ?? ""))
      throw new TypeError(`qualification violation ${field} is invalid`);
  return Object.freeze({
    protocol: "clockgrove.factory/qualification-violation",
    code: input.code,
    phase: input.phase,
    item: input.item,
    field: input.field,
    expected: input.expected,
    observed: safeValue(input.observed),
  });
}

export class QualificationViolation extends Error {
  constructor(input) {
    super("qualification invariant failed");
    this.name = "QualificationViolation";
    this.violation = violation(input);
  }
}

export function qualificationInvariant(condition, input) {
  if (!condition) throw new QualificationViolation(input);
}

export function qualificationViolation(error) {
  return error instanceof QualificationViolation ? error.violation : undefined;
}
