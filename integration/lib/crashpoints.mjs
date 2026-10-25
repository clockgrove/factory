#!/usr/bin/env node
// Enumerate a Factory build's crash points from its crashPoint() call sites.
//
//   node crashpoints.mjs BUILD lists        one line per point: LIST<TAB>POINT<TAB>yes|no
//   node crashpoints.mjs BUILD check P...   one line per point: POINT<TAB>yes|no
//
// The sites are read from the build's source (BUILD/src) with the
// TypeScript parser. A site whose name is a template over a parameter
// (`${point}:before` in ensureComment) is resolved through every call of that
// function, so `ensureComment(..., "sync:ask")` gives sync:ask:before and
// sync:ask:after. A part that stays dynamic (a step key, a planner-chosen id)
// becomes `*`, which FACTORY_CRASH_AT matches as any text.
//
// LIST is CRASH_POINTS or GITHUB:
// - CRASH_POINTS is the local list CI crashes at, read from
//   test/crash.test.mjs. Its yes|no says whether a site produces it.
// - GITHUB is every other site, minus the families that other groups drive
//   on their own (see LOCAL below). Every GITHUB point has a site, so it is
//   always "yes".
// `check` says whether some site produces each point; a "#n" suffix (the n-th
// time the point is reached) is ignored.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [build, mode, ...args] = process.argv.slice(2);
if (!build || !["lists", "check"].includes(mode)) {
  console.error("usage: crashpoints.mjs BUILD lists|check [POINT...]");
  process.exit(2);
}
// The build's own TypeScript, else the one next to this suite.
let ts;
for (const from of [join(build, "package.json"), import.meta.url]) {
  try {
    ts = createRequire(from)("typescript");
    break;
  } catch {
    // Not installed there: try the next place.
  }
}
if (!ts) {
  console.error("crashpoints.mjs: typescript not found (run npm ci)");
  process.exit(2);
}

// Families with their own groups and scenarios, never the GitHub list:
// step boundaries (queue, plan, exec), state saves, knowledge and dream
// (knowledge), managed provider sessions (providers).
const LOCAL = [/^engine:\*:/, /^state:/, /^knowledge:/, /^dream:/, /^managed:/];

function files(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

const sources = files(join(build, "src")).map((path) =>
  ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  ),
);
if (!sources.length) {
  console.error(`crashpoints.mjs: no TypeScript under ${build}/src`);
  process.exit(2);
}

const calleeName = (call) => {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
};
const fnName = (fn) => {
  if (fn.name && (ts.isIdentifier(fn.name) || ts.isPrivateIdentifier(fn.name)))
    return fn.name.text;
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name))
    return p.name.text;
  if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name))
    return p.name.text;
  return undefined;
};
const enclosingFn = (node) => {
  for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n)) return n;
  return undefined;
};

// Every call, by callee name, for resolving a parameter through its callers.
const calls = new Map();
const sites = [];
for (const sf of sources) {
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name === "crashPoint" && node.arguments.length) sites.push(node);
      else if (name) {
        if (!calls.has(name)) calls.set(name, []);
        calls.get(name).push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// The names an expression can take, with "*" for a dynamic part.
function values(expr, depth = 0) {
  if (!expr || depth > 6) return ["*"];
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
    return [expr.text];
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr))
    return values(expr.expression, depth);
  if (ts.isConditionalExpression(expr))
    return [...values(expr.whenTrue, depth), ...values(expr.whenFalse, depth)];
  if (ts.isTemplateExpression(expr)) {
    let out = [expr.head.text];
    for (const span of expr.templateSpans) {
      const parts = values(span.expression, depth);
      out = out.flatMap((pre) =>
        parts.map((part) => pre + part + span.literal.text),
      );
    }
    return out;
  }
  if (ts.isIdentifier(expr))
    return constValues(expr, depth) ?? parameterValues(expr, depth);
  return ["*"];
}

// A const declared in an enclosing function: the values of its initializer.
function constValues(id, depth) {
  for (let fn = enclosingFn(id); fn; fn = enclosingFn(fn)) {
    let found;
    const visit = (node) => {
      if (found) return;
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === id.text &&
        node.initializer &&
        ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const
      )
        found = node.initializer;
      else ts.forEachChild(node, visit);
    };
    if (fn.body) visit(fn.body);
    if (found) return values(found, depth + 1);
  }
  return undefined;
}

// An identifier that is a parameter of its function: the values its callers
// pass at that position. Anything else is dynamic.
// A destructured option (`{ point = "plan" }: Options`) takes the property
// of the caller's object literal, or its default.
function parameterValues(id, depth) {
  const fn = enclosingFn(id);
  const name = fn && fnName(fn);
  if (!name) return ["*"];
  let index = -1;
  let element;
  fn.parameters.forEach((p, i) => {
    if (ts.isIdentifier(p.name) && p.name.text === id.text) index = i;
    if (ts.isObjectBindingPattern(p.name)) {
      const e = p.name.elements.find(
        (e) => ts.isIdentifier(e.name) && e.name.text === id.text,
      );
      if (e) [index, element] = [i, e];
    }
  });
  if (index < 0) return ["*"];
  const out = [];
  for (const call of calls.get(name) ?? []) {
    let arg = call.arguments[index];
    if (arg && ts.isSpreadElement(arg)) continue;
    if (element) {
      const key = (element.propertyName ?? element.name).text;
      const prop =
        arg &&
        ts.isObjectLiteralExpression(arg) &&
        arg.properties.find(
          (p) =>
            ts.isPropertyAssignment(p) &&
            ts.isIdentifier(p.name) &&
            p.name.text === key,
        );
      arg = prop ? prop.initializer : element.initializer;
    }
    if (arg) out.push(...values(arg, depth + 1));
  }
  return out.length ? out : ["*"];
}

const points = new Set();
for (const site of sites)
  for (const v of values(site.arguments[0]))
    if (v !== "*") points.add(v.replace(/\*+/g, "*"));

const pattern = (name) =>
  new RegExp(
    `^${name
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".+")}$`,
  );
const sitePatterns = [...points].map(pattern);
// A point name may hold "*" (any planner-chosen id): test it with a sample id.
const hasSite = (point) => {
  const name = point.split("#")[0].replaceAll("*", "x");
  return sitePatterns.some((re) => re.test(name));
};

function localList() {
  let text;
  try {
    text = readFileSync(join(build, "test", "crash.test.mjs"), "utf8");
  } catch {
    return [];
  }
  const m = text.match(/const CRASH_POINTS\s*=\s*\[([\s\S]*?)\]/);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
}

if (mode === "lists") {
  const local = localList();
  const localNames = new Set(local.map((p) => p.split("#")[0]));
  for (const p of local)
    console.log(`CRASH_POINTS\t${p}\t${hasSite(p) ? "yes" : "no"}`);
  for (const p of [...points].sort())
    if (!localNames.has(p) && !LOCAL.some((re) => re.test(p)))
      console.log(`GITHUB\t${p}\tyes`);
} else {
  for (const p of args) console.log(`${p}\t${hasSite(p) ? "yes" : "no"}`);
}
