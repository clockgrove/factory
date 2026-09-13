import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPublishReadiness } from "./verify-publish-readiness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
// Direct invocation verifies the candidate and consumes only that validated snapshot.
const { tarball, access, distTag } = await verifyPublishReadiness();

const publishArguments = ["publish", tarball, "--access", access, "--tag", distTag];
if (dryRun) publishArguments.push("--dry-run");

const result = spawnSync("npm", publishArguments, {
  cwd: root,
  encoding: "utf8",
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
