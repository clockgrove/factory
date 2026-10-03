import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { directiveProblems } from "../scripts/check-ts-directives.mjs";

test("directive check flags real comments only", () => {
  const source = [
    "// @ts-nocheck",
    '/// <reference types="node" />',
    "// @ts-expect-error",
    'export const a: number = "x";',
    "/* @ts-expect-error: */",
    'export const b: number = "x";',
    "// @ts-ignore because",
    "export const c = 1;",
    "/**",
    " * @ts-ignore",
    " */",
    "export const d = 1;",
    "// @ts-expect-error -- string is checked at runtime",
    'export const e: number = "x";',
    'export const s = "// @ts-nocheck";',
    "export const t = `/* @ts-ignore */ ${s} // @ts-nocheck`;",
    "export const r = /\\/\\/ @ts-ignore/;",
    "// Mentions of @ts-ignore inside prose are fine.",
    "export const f = 1; // @ts-ignore trailing",
  ].join("\n");
  assert.deepEqual(directiveProblems("probe.ts", source), [
    "1: @ts-nocheck is not allowed",
    "2: triple-slash reference; use an import",
    "3: @ts-expect-error needs a reason",
    "5: @ts-expect-error needs a reason",
    "7: @ts-ignore is not allowed",
    "9: @ts-ignore is not allowed",
    "19: @ts-ignore is not allowed",
  ]);
});

test("directive check passes the repository's src", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/check-ts-directives.mjs"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});
