import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export function renderCatalog(input) {
  const rows = Object.entries(input)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      if (
        !/^[a-z]+$/.test(key) ||
        typeof value.label !== "string" ||
        !Number.isSafeInteger(value.rank)
      )
        throw new Error("invalid status record");
      return `  ${key}: { label: ${JSON.stringify(value.label)}, rank: ${value.rank} },`;
    });
  return `export const status = {\n${rows.join("\n")}\n};\n`;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(await readFile(new URL("../data/status.json", import.meta.url), "utf8"));
  await writeFile(new URL("../generated/status.mjs", import.meta.url), renderCatalog(input));
}
