import "./temp.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { autoInstalls, installCommand, installDeps } from "../scripts/lib/checkout.mjs";

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

test("install: an install that exits 0 but leaves a dependency's binary missing is repaired by a clean reinstall", async () => {
  const f = fixture({ heals: true });
  // What the pnpm store held before the repair stays: the reinstall starts from it.
  mkdirSync(join(f.checkout, "node_modules", ".pnpm-store"), { recursive: true });
  writeFileSync(join(f.checkout, "node_modules", ".pnpm-store", "kept"), "");
  const r = await installDeps(f.checkout, f.command, { env: f.env });
  assert.equal(r.ok, true);
  assert.equal(r.repaired, true);
  assert.match(r.first, /node_modules\/typescript\/bin\/tsc missing/);
  assert.ok(existsSync(join(f.checkout, "node_modules", "typescript", "bin", "tsc")));
  assert.ok(existsSync(join(f.checkout, "node_modules", ".pnpm-store", "kept")));
});

test("install: still incomplete after the reinstall, it fails as infrastructure naming the missing path, never as a validation result", async () => {
  const f = fixture({ heals: false });
  const r = await installDeps(f.checkout, f.command, { env: f.env });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["node_modules/typescript/bin/tsc"]);
  assert.match(r.reason, /^install failed \(infrastructure, not a validation result; validation did not run\)/);
  assert.match(r.reason, /again after a clean reinstall/);
});

test("install: a non-zero exit is retried once, then fails as infrastructure with its exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "install-"));
  const r = await installDeps(dir, "exit 7", { env: process.env });
  assert.equal(r.ok, false);
  assert.match(r.reason, /exit 7 exited 7, and again after a clean reinstall: exited 7$/);
});

test("install: a dangling dependency link is missing; local packages, install-script packages and unlinked ones are not checked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "install-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { gone: "1.0.0", lib: "workspace:*", built: "1.0.0", hoisted: "1.0.0" } }));
  mkdirSync(join(dir, "packages", "lib"), { recursive: true });
  writeFileSync(join(dir, "packages", "lib", "package.json"), JSON.stringify({ name: "lib", bin: "dist/cli.js" }));
  // Each run links the same: `built`'s bin comes from its postinstall, `lib` is the workspace's, `gone` points nowhere.
  const built = JSON.stringify({ name: "built", bin: "cli.js", scripts: { postinstall: "node make-cli.js" } });
  const install = `mkdir -p node_modules/built && echo '${built}' > node_modules/built/package.json && ln -sfn ../packages/lib node_modules/lib && ln -sfn .pnpm/gone node_modules/gone`;
  const r = await installDeps(dir, install, { env: process.env });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["node_modules/gone"]);
});

test("auto install: every ecosystem whose lockfile is there is installed, not only the first; package.json's packageManager picks the Node.js one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "install-all-"));
  const bin = join(dir, ".bin");
  mkdirSync(bin);
  // Stand-ins for the package managers: each leaves a marker of the command it ran.
  for (const tool of ["npm", "pnpm", "cargo", "go"]) writeFileSync(join(bin, tool), `#!/bin/sh\necho "$*" > "${join(dir, `ran-${tool}`)}"\n`, { mode: 0o755 });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
  writeFileSync(join(dir, "package-lock.json"), "{}");
  writeFileSync(join(dir, "Cargo.lock"), "");
  writeFileSync(join(dir, "go.sum"), "");
  const command = installCommand(dir);
  assert.equal(command, "npm ci --ignore-scripts && cargo fetch --locked && go mod download");
  const result = await installDeps(dir, command, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeoutMs: 30_000 });
  assert.equal(result.ok, true);
  assert.equal(readFileSync(join(dir, "ran-npm"), "utf8").trim(), "ci --ignore-scripts");
  assert.equal(readFileSync(join(dir, "ran-cargo"), "utf8").trim(), "fetch --locked", "the Cargo.lock beside the package-lock.json is installed too");
  assert.equal(readFileSync(join(dir, "ran-go"), "utf8").trim(), "mod download");
  // Two Node.js lockfiles are alternatives for one package.json: one install, the one packageManager names.
  writeFileSync(join(dir, "pnpm-lock.yaml"), "");
  assert.deepEqual(autoInstalls(dir).map((i) => i.lockfile), ["pnpm-lock.yaml", "Cargo.lock", "go.sum"], "with no packageManager, the table's order");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", packageManager: "npm@10.9.0" }));
  assert.deepEqual(autoInstalls(dir).map((i) => i.lockfile), ["package-lock.json", "Cargo.lock", "go.sum"]);
  assert.equal(installCommand(dir, "none"), null);
  assert.equal(installCommand(dir, "make deps"), "make deps", "a given command wins");
});
