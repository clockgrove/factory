import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildFactory } from "./build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "factory-dist-"));
const digest = (value) => createHash("sha256").update(value).digest("hex");

try {
  await buildFactory(temporaryDirectory, { logLevel: "silent" });
  for (const name of ["factory.js", "mcp-server.js", "bundle-inventory.json"]) {
    const committedPath = resolve(root, "dist", name);
    const generatedPath = resolve(temporaryDirectory, name);
    await access(committedPath);
    const committed = await readFile(committedPath);
    const generated = await readFile(generatedPath);
    if (!committed.equals(generated)) {
      throw new Error(
        `dist/${name} is stale (committed ${digest(committed)}, generated ${digest(generated)}); run npm run build`,
      );
    }
  }
  const committedNotices = await readFile(resolve(root, "THIRD_PARTY_NOTICES.txt"));
  const generatedNotices = await readFile(resolve(temporaryDirectory, "THIRD_PARTY_NOTICES.txt"));
  if (!committedNotices.equals(generatedNotices)) {
    throw new Error("THIRD_PARTY_NOTICES.txt is stale; run npm run build");
  }

  const cliPath = resolve(root, "dist", "factory.js");
  const cli = await readFile(cliPath, "utf8");
  if (!cli.startsWith("#!/usr/bin/env node\n")) {
    throw new Error("dist/factory.js must start with a portable Node shebang");
  }
  if (((await stat(cliPath)).mode & 0o111) === 0) {
    throw new Error("dist/factory.js must be executable");
  }
  process.stdout.write("committed bundles are reproducible and current\n");
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
