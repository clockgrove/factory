import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installDeps } from "../scripts/lib/checkout.mjs";

// A checkout whose package.json needs `typescript` (bin tsc). `install` is a shell script standing in for the package
// manager: the first run leaves the package's bin out (an interrupted or partial install), later runs per `heals`.
const fixture = ({ heals }) => {
  const dir = mkdtempSync(join(tmpdir(), "install-"));
  const checkout = join(dir, "repo");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "app", devDependencies: { typescript: "7.0.2" } }));
  const runs = join(dir, "runs");
  const script = join(dir, "install.sh");
  writeFileSync(
    script,
    [
      "set -e",
      `echo run >> ${runs}`,
      "mkdir -p node_modules/typescript/bin node_modules/.pnpm-store",
      `echo '{"name":"typescript","bin":{"tsc":"bin/tsc"}}' > node_modules/typescript/package.json`,
      `if [ "$(wc -l < ${runs})" -gt 1 ] && [ ${heals ? 1 : 0} = 1 ]; then echo '#!/usr/bin/env node' > node_modules/typescript/bin/tsc; fi`,
    ].join("\n"),
  );
  const env = { ...process.env, pnpm_config_store_dir: join(checkout, "node_modules", ".pnpm-store") };
  return { checkout, command: `bash ${script}`, env, runs };
};

test("install: still incomplete after the reinstall, it fails as infrastructure naming the missing path, never as a validation result", async () => {
  const f = fixture({ heals: false });
  const r = await installDeps(f.checkout, f.command, { env: f.env });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["node_modules/typescript/bin/tsc"]);
  assert.match(r.reason, /^install failed \(infrastructure, not a validation result; validation did not run\)/);
  assert.match(r.reason, /again after a clean reinstall/);
});

