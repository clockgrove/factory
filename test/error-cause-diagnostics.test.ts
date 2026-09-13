import { expect, it } from "vitest";
import { safeDiagnosticMessage } from "../src/application/doctor.js";

it("retains the original artifact-transfer cause at the tool diagnostic boundary", () => {
  const failure = new Error("collected output is not durably retained", {
    cause: new Error("artifact transfer ref publication conflicted", {
      cause: new Error("intent ref was not visible after creation"),
    }),
  });
  expect(safeDiagnosticMessage(failure, { causes: true })).toBe(
    "collected output is not durably retained; caused by: artifact transfer ref publication conflicted; caused by: intent ref was not visible after creation",
  );
  expect(safeDiagnosticMessage(failure)).toBe("collected output is not durably retained");
});

it("bounds cyclic/deep causes and redacts credentials without emitting request objects", () => {
  const secret = "github_pat_abcdefghijklmnopqrstuvwxyz";
  const root = new Error("outer");
  const cause = Object.assign(new Error(`HTTP failure Bearer ${secret}\nretry later`), {
    cause: root,
    request: { authorization: secret, body: "private request body" },
  });
  root.cause = cause;
  const output = safeDiagnosticMessage(root, { causes: true });
  expect(output).toContain("[REDACTED]");
  expect(output).not.toContain(secret);
  expect(output).not.toContain("private request body");
  expect(output.split("; caused by: ")).toHaveLength(2);
  let deep = new Error("x".repeat(5000));
  for (let i = 0; i < 20; i++) deep = new Error("x".repeat(5000), { cause: deep });
  expect(safeDiagnosticMessage(deep, { causes: true }).length).toBeLessThanOrEqual(4060);
});
