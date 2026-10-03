import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bump, check, releaseNotes, versions } from "../scripts/version.mjs";

function fixture(version = "1.2.3") {
  const root = mkdtempSync(join(tmpdir(), "factory-version-"));
  mkdirSync(join(root, ".codex-plugin"));
  mkdirSync(join(root, ".agents", "plugins"), { recursive: true });
  const json = (path, value) =>
    writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
  json("package.json", { name: "@clockgrove/factory", version });
  json("package-lock.json", {
    name: "@clockgrove/factory",
    version,
    lockfileVersion: 3,
    packages: { "": { name: "@clockgrove/factory", version } },
  });
  json(".codex-plugin/plugin.json", { name: "factory", version });
  json(".agents/plugins/marketplace.json", {
    name: "clockgrove",
    plugins: [
      { name: "other", source: { ref: "v9.9.9" } },
      { name: "factory", source: { source: "url", ref: `v${version}` } },
    ],
  });
  writeFileSync(
    join(root, "CHANGELOG.md"),
    `# Changelog\n\nIntro.\n\n## ${version} — 2026-01-01\n\n- Earlier change.\n`,
  );
  return root;
}

test("check accepts aligned identities and reports each mismatch", () => {
  const root = fixture();
  try {
    assert.deepEqual(check("1.2.3", root), []);
    const problems = check("1.2.4", root);
    assert.equal(problems.length, 6);
    assert.match(problems.at(-1), /no non-empty "## 1\.2\.4" section/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bump moves every identity and adds a changelog heading that check refuses until filled in", () => {
  const root = fixture();
  try {
    bump("1.3.0", root, new Date("2026-10-03T00:00:00Z"));
    assert.deepEqual(
      new Set(Object.values(versions(root))),
      new Set(["1.3.0"]),
    );
    const marketplace = JSON.parse(
      readFileSync(join(root, ".agents/plugins/marketplace.json"), "utf8"),
    );
    assert.equal(marketplace.plugins[0].source.ref, "v9.9.9");
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    assert.ok(
      changelog.indexOf("## 1.3.0 — 2026-10-03") <
        changelog.indexOf("## 1.2.3"),
    );
    assert.deepEqual(check("1.3.0", root), [
      'CHANGELOG.md "## 1.3.0" still contains a TODO',
    ]);
    bump("1.3.0", root);
    assert.equal(
      readFileSync(join(root, "CHANGELOG.md"), "utf8").match(/## 1\.3\.0/g)
        .length,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("releaseNotes returns only the requested section", () => {
  const changelog =
    "# Changelog\n\n## 0.2.0 — x\n\n- New.\n\n## 0.1.10 — y\n\n- Old.\n\n## 0.1.1 — z\n\n- Older.\n";
  assert.equal(releaseNotes("0.2.0", changelog), "- New.");
  assert.equal(releaseNotes("0.1.1", changelog), "- Older.");
  assert.equal(releaseNotes("0.1.2", changelog), undefined);
});
