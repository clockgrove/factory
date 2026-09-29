// Model-free fixture check; never creates a remote or imports Factory runtime state.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { finalObjectiveCommands, planningSources } from "../dist/compiler.js";

const root = mkdtempSync(join(tmpdir(), "factory-autonomy-preflight-"));
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commit = (message) => {
  git("add", ".");
  git(
    "-c",
    "user.name=Factory Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    message,
  );
  return git("rev-parse", "HEAD");
};
const sourcePacket = (name, base, expectedCommands, paths) => {
  const body = readFileSync(
    new URL(`./fixtures/objectives/${name}.md`, import.meta.url),
    "utf8",
  );
  assert.deepEqual(finalObjectiveCommands(body), expectedCommands);
  const packet = planningSources(body, base, root);
  assert.deepEqual(
    packet.map((source) => source.path),
    ["OBJECTIVE", "AGENTS.md", "README.md", ...paths],
  );
  for (const source of packet) {
    const expected =
      source.path === "OBJECTIVE"
        ? body
        : readFileSync(join(root, source.path), "utf8");
    assert.equal(source.content, expected, `Complete pinned ${source.path}`);
  }
};
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
  git("init", "-b", "main");
  sourcePacket(
    "autonomy-first",
    commit("Public unfinished baseline"),
    ["node scripts/check.mjs qa", "factory-fixture-prerequisite"],
    ["scripts/check.mjs"],
  );
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
  sourcePacket(
    "autonomy-second",
    commit("Public completed first Objective baseline"),
    ["node scripts/check.mjs guide", "node scripts/check.mjs qa"],
    ["scripts/check.mjs", "src/alpha.mjs", "src/beta.mjs", "src/summary.mjs"],
  );
  writeFileSync(
    join(root, "src/summary.mjs"),
    "export const summarize = values => { values.sort(); return { total: values.reduce((sum, value) => sum + value, 0), maximum: values.length ? Math.max(...values) : null }; };\n",
  );
  check("join", true);
  check("qa", false);
  writeFileSync(
    join(root, "GUIDE.md"),
    "summarize returns total and maximum; [] has null maximum.\n",
  );
  check("guide", true);
  console.log(
    "Public fixture preflight passed: literal final commands and complete pinned sources match both baselines; incomplete implementation rejects; complete candidate passes; ordinary join permits mutation but independent QA rejects it. No runtime qualification claimed.",
  );
} finally {
  // Only this process's temporary local mechanical fixture; no remote or runtime evidence.
  rmSync(root, { recursive: true, force: true });
}
