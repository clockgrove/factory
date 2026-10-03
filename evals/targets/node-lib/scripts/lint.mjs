import { readdirSync, readFileSync } from "node:fs";

let failed = false;
for (const name of readdirSync(new URL("../src/", import.meta.url))) {
  const text = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
  if (text.includes("\t")) {
    console.error(`${name}: tabs are not allowed`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
