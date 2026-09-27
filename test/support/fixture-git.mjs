// Test-only transport boundary: inspect real Git configuration unchanged, but
// route registered GitHub fixture URLs to real local bare repositories for I/O.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const [realGit, routesFile, ...args] = process.argv.slice(2);
const routes = JSON.parse(readFileSync(routesFile, "utf8"));
const configuration = Object.entries(routes).flatMap(([url, origin]) => [
  "-c",
  `url.${origin}.insteadOf=${url}`,
]);
const result = spawnSync(realGit, [...configuration, ...args], {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
