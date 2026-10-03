// Directives Biome does not check: TypeScript must check every src file.
// Bans @ts-nocheck, @ts-ignore, triple-slash references, and @ts-expect-error
// without a reason. Only real comments count, found with the TypeScript
// scanner, so strings and template literals never match.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

/** Every comment in a source file, each once. */
function comments(source) {
  const text = source.getFullText();
  const seen = new Map();
  const collect = (ranges) => {
    for (const range of ranges ?? [])
      seen.set(range.pos, text.slice(range.pos, range.end));
  };
  const visit = (node) => {
    collect(ts.getLeadingCommentRanges(text, node.pos));
    collect(ts.getTrailingCommentRanges(text, node.end));
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return [...seen].sort(([a], [b]) => a - b);
}

/** Problems in one file's text, as `line: message`. */
export function directiveProblems(fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest);
  const problems = [];
  for (const [pos, comment] of comments(source)) {
    const line = source.getLineAndCharacterOfPosition(pos).line + 1;
    if (/^\/\/\/\s*<reference\b/.test(comment))
      problems.push(`${line}: triple-slash reference; use an import`);
    const body = comment.replace(/^\/\/+|^\/\*+|\*\/$/g, "");
    for (const part of body.split("\n")) {
      const match =
        /^[\s*]*@ts-(nocheck|ignore|expect-error)\b[\s:-]*(.*)/i.exec(part);
      if (!match) continue;
      // tsc honours these directives in any letter case.
      const name = match[1].toLowerCase();
      if (name !== "expect-error")
        problems.push(`${line}: @ts-${name} is not allowed`);
      else if (match[2].trim().length < 3)
        problems.push(`${line}: @ts-expect-error needs a reason`);
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const problems = [];
  for (const entry of readdirSync(join(root, "src"), { recursive: true })) {
    if (!entry.endsWith(".ts")) continue;
    const file = join(root, "src", entry);
    for (const problem of directiveProblems(file, readFileSync(file, "utf8")))
      problems.push(`${relative(root, file)}:${problem}`);
  }
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
}
