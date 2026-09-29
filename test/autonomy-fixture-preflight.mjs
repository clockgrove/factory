// Model-free fixture check; never creates a remote or imports Factory runtime state.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "factory-autonomy-preflight-"));
const check = (phase, pass) => {
  const result = spawnSync(process.execPath, ["scripts/check.mjs", phase], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status === 0, pass, `${phase}: ${result.stderr}`);
};
try {
  cpSync(new URL("./fixtures/autonomous-target/", import.meta.url), root, {
    recursive: true,
  });
  for (const phase of ["alpha", "beta", "join", "qa", "guide"]) {
    check(phase, false);
  }
  writeFileSync(
    join(root, "src/alpha.mjs"),
    "export const alpha = values => values.reduce((sum, value) => sum + value, 0);\n",
  );
  writeFileSync(
    join(root, "src/beta.mjs"),
    "export const beta = values => values.length ? Math.max(...values) : null;\n",
  );
  writeFileSync(
    join(root, "src/summary.mjs"),
    "import { alpha } from './alpha.mjs';\nimport { beta } from './beta.mjs';\nexport const summarize = values => ({ total: alpha(values), maximum: beta(values) });\n",
  );
  for (const phase of ["alpha", "beta", "join", "qa"]) check(phase, true);
  writeFileSync(
    join(root, "src/summary.mjs"),
    "export const summarize = values => { values.sort(); return { total: values.reduce((sum, value) => sum + value, 0), maximum: values.length ? Math.max(...values) : null }; };\n",
  );
  check("qa", false);
  writeFileSync(
    join(root, "GUIDE.md"),
    "summarize returns total and maximum; [] has null maximum.\n",
  );
  check("guide", true);
  console.log(
    "Public fixture preflight passed: incomplete baseline rejects; complete candidate passes; mutation rejects. No runtime qualification claimed.",
  );
} finally {
  // Only this process's newly created temporary fixture; no Git repository or run evidence.
  rmSync(root, { recursive: true, force: true });
}
