// Directives Biome does not check: TypeScript must check every src file.
// Bans @ts-nocheck, @ts-ignore, triple-slash references, and @ts-expect-error
// without a reason.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const directive =
  /(?:\/\/|\/\*)\s*@ts-(nocheck|ignore|expect-error)\b[\s:-]*(.*)/;
const problems = [];
for (const entry of readdirSync(join(root, "src"), { recursive: true })) {
  if (!entry.endsWith(".ts")) continue;
  const file = join(root, "src", entry);
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      const at = `${relative(root, file)}:${index + 1}`;
      if (/^\s*\/\/\/\s*<reference\b/.test(line))
        problems.push(`${at}: triple-slash reference; use an import`);
      const match = directive.exec(line);
      if (!match) return;
      const reason = match[2].replace(/\*\/.*$/, "").trim();
      if (match[1] !== "expect-error")
        problems.push(`${at}: @ts-${match[1]} is not allowed`);
      else if (reason.length < 3)
        problems.push(`${at}: @ts-expect-error needs a reason`);
    });
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
