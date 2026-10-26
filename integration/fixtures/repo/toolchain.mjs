// The prd suite's toolchain case (cases/prd.sh case_toolchain) commits this
// as drill/toolchain.mjs, the body of the `toolchain` script its installation
// requires as a final command (`pnpm run toolchain`). It passes only when it
// runs under the package manager and version package.json pins
// (packageManager) and a node that matches the .nvmrc pin.
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const pin = readFileSync(new URL(".nvmrc", root), "utf8").trim().replace(/^v/, "");
const manager = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).packageManager ?? "";
const [name, version] = manager.split("+")[0].split("@");
// pnpm and npm name themselves first in the user agent they give a script: "pnpm/12.6.0 npm/? node/? linux x64".
const agent = (process.env.npm_config_user_agent ?? "").split(" ")[0];
const node = process.versions.node;

const problems = [];
if (!pin || (node !== pin && !node.startsWith(`${pin}.`))) problems.push(`node ${node} is outside the .nvmrc pin ${pin || "(empty)"}`);
if (!name || !version || agent !== `${name}/${version}`) problems.push(`it ran under ${agent || "no package manager"}, not packageManager ${manager || "(none)"}`);
console.log(`toolchain: node ${node} (.nvmrc ${pin}), ${agent || "no package manager"} (packageManager ${manager})`);
if (problems.length) {
  console.error(`toolchain: ${problems.join("; ")}`);
  process.exit(1);
}
