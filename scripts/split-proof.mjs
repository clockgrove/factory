#!/usr/bin/env node
// Proves a file split is a pure move (docs/LANDING.md#prove-a-split).
//
//   node scripts/split-proof.mjs BEFORE AFTER PATH...
//
// BEFORE and AFTER are checkouts (git worktree add --detach DIR COMMIT).
// PATHs are relative to the repository root; a trailing / takes every file
// in that directory. TypeScript and JavaScript files are compared per
// top-level declaration: its full text with its doc comment, whitespace,
// `export` and formatter-only trailing commas normalized away. Tests are
// keyed by title, `for` loops by what they iterate, and the CLI's command
// specs by command. Markdown files are compared as a multiset of lines, with
// link targets reduced to their anchor and heading levels ignored. A name
// declared in several files (test helpers, say) is matched by its text
// first, so a directory of independent files gives no false differences.
// Exits 1 when a declaration was removed, added or changed (printed with
// word-level hunks) or a Markdown line went missing. New Markdown lines,
// such as a new file's title, are listed for review but don't fail: check
// them, and run a link check.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [before, after, ...paths] = process.argv.slice(2);
if (!before || !after || !paths.length) {
  console.error("usage: split-proof.mjs BEFORE AFTER PATH...");
  process.exit(2);
}
const ts = createRequire(import.meta.url)("typescript");

function files(root) {
  const out = [];
  for (const path of paths) {
    const full = join(root, path);
    if (!existsSync(full)) continue;
    if (path.endsWith("/"))
      for (const name of readdirSync(full).sort())
        if (/\.(ts|mts|js|mjs|md)$/.test(name)) out.push(join(path, name));
        else continue;
    else out.push(path);
  }
  return out;
}

const norm = (text) =>
  text
    .replace(
      /\bexport (?=(default |async |function|const|let|class|interface|type))/g,
      "",
    )
    .replace(/\s+/g, " ")
    .replace(/,\s*([)\]}])/g, " $1")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();

function declarations(root) {
  const found = new Map();
  for (const file of files(root).filter((f) => !f.endsWith(".md"))) {
    const text = readFileSync(join(root, file), "utf8");
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const add = (name, body) => {
      found.set(name, [...(found.get(name) ?? []), { file, text: norm(body) }]);
    };
    for (const statement of source.statements) {
      if (
        ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)
      )
        continue;
      if (ts.isVariableStatement(statement)) {
        const names = [];
        for (const d of statement.declarationList.declarations) {
          const name = d.name.getText();
          const object =
            d.initializer && ts.isObjectLiteralExpression(d.initializer)
              ? d.initializer
              : undefined;
          // A command table's entries and a command module's `spec` compare per command.
          if (object && (name === "COMMANDS" || name === "specs")) {
            for (const p of object.properties)
              if (
                ts.isPropertyAssignment(p) &&
                ts.isObjectLiteralExpression(p.initializer)
              )
                add(
                  `command ${p.name.getText().replace(/"/g, "")}`,
                  p.initializer.getFullText(),
                );
            continue;
          }
          if (object && name === "spec") {
            add(
              `command ${file.replace(/^.*\//, "").replace(/\.\w+$/, "")}`,
              object.getFullText(),
            );
            continue;
          }
          names.push(name);
        }
        if (names.length) add(names.join(", "), statement.getFullText());
        continue;
      }
      const call =
        ts.isExpressionStatement(statement) &&
        ts.isCallExpression(statement.expression)
          ? statement.expression
          : undefined;
      const title =
        call?.arguments[0] &&
        (ts.isStringLiteral(call.arguments[0]) ||
          ts.isNoSubstitutionTemplateLiteral(call.arguments[0]))
          ? call.arguments[0].text
          : undefined;
      const name =
        statement.name?.getText() ??
        (title !== undefined
          ? `${call.expression.getText()} "${title}"`
          : ts.isForOfStatement(statement)
            ? `for ${norm(statement.expression.getText()).slice(0, 80)}`
            : ts.isIfStatement(statement)
              ? `if ${norm(statement.expression.getText()).slice(0, 80)}`
              : call
                ? `${call.expression.getText()}(…)`
                : `statement at ${file}:${source.getLineAndCharacterOfPosition(statement.getStart()).line + 1}`);
      add(name, statement.getFullText());
    }
  }
  return found;
}

const line = (text) =>
  text
    .replace(/\]\([^)#\s]*#/g, "](#")
    .replace(/(?:docs\/)?(?:[\w-]+\/)*[\w-]+\.md#/g, "#")
    .replace(/^#+ /, "# ")
    .replace(/-{3,}/g, "---")
    .replace(/\s+/g, " ")
    .trim();

function lines(root) {
  const counts = new Map();
  for (const file of files(root).filter((f) => f.endsWith(".md")))
    for (const each of readFileSync(join(root, file), "utf8").split("\n")) {
      const key = line(each);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  return counts;
}

function words(a, b) {
  const x = a.split(" ");
  const y = b.split(" ");
  const table = Array.from(
    { length: x.length + 1 },
    () => new Int32Array(y.length + 1),
  );
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      table[i][j] =
        x[i] === y[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
  const hunks = [];
  let i = 0;
  let j = 0;
  let gone = [];
  let come = [];
  const flush = () => {
    if (gone.length || come.length)
      hunks.push(
        `  - ${gone.join(" ") || "(nothing)"}\n  + ${come.join(" ") || "(nothing)"}`,
      );
    gone = [];
    come = [];
  };
  while (i < x.length || j < y.length)
    if (i < x.length && j < y.length && x[i] === y[j]) {
      flush();
      i++;
      j++;
    } else if (
      j < y.length &&
      (i === x.length || table[i][j + 1] >= table[i + 1][j])
    )
      come.push(y[j++]);
    else gone.push(x[i++]);
  flush();
  return hunks.join("\n");
}

let differs = false;
const a = declarations(before);
const b = declarations(after);
if (a.size || b.size) {
  const count = (m) => [...m.values()].reduce((n, list) => n + list.length, 0);
  let same = 0;
  let moved = 0;
  const changed = [];
  const removed = [];
  const added = [];
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const olds = [...(a.get(name) ?? [])];
    const news = [...(b.get(name) ?? [])];
    // Same name and text first: preferring the same file, then any file.
    for (const sameFile of [true, false])
      for (let i = olds.length - 1; i >= 0; i--) {
        const j = news.findIndex(
          (now) =>
            now.text === olds[i].text &&
            (!sameFile || now.file === olds[i].file),
        );
        if (j < 0) continue;
        same++;
        if (news[j].file !== olds[i].file) moved++;
        olds.splice(i, 1);
        news.splice(j, 1);
      }
    // What is left pairs up as changed; the rest was removed or added.
    while (olds.length && news.length) {
      const old = olds.shift();
      const now = news.shift();
      changed.push(
        `--- ${name} (${old.file} -> ${now.file})\n${words(old.text, now.text)}`,
      );
    }
    for (const old of olds) removed.push(`${name} (${old.file})`);
    for (const now of news) added.push(`${name} (${now.file})`);
  }
  console.log(`declarations before: ${count(a)}, after: ${count(b)}`);
  console.log(`identical: ${same} (${moved} moved to another file)`);
  console.log(`removed: ${removed.join("; ") || "none"}`);
  console.log(`added: ${added.join("; ") || "none"}`);
  console.log(
    `changed: ${changed.length ? `${changed.length}\n${changed.join("\n")}` : "none"}`,
  );
  differs ||= removed.length + added.length + changed.length > 0;
}
const la = lines(before);
const lb = lines(after);
if (la.size || lb.size) {
  const minus = (x, y) =>
    [...x].flatMap(([k, n]) => Array(Math.max(0, n - (y.get(k) ?? 0))).fill(k));
  const lost = minus(la, lb);
  const extra = minus(lb, la);
  const total = (m) => [...m.values()].reduce((s, n) => s + n, 0);
  console.log(`markdown lines before: ${total(la)}, after: ${total(lb)}`);
  console.log(`missing after: ${lost.length}`);
  for (const l of lost) console.log(`  - ${l.slice(0, 160)}`);
  console.log(`new after: ${extra.length}`);
  for (const l of extra) console.log(`  + ${l.slice(0, 160)}`);
  differs ||= lost.length > 0;
}
process.exit(differs ? 1 : 0);
