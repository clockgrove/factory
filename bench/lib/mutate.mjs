/**
 * The auto-grader's mutation pass (bench/lib/grade-auto.mjs, #2275): mutants
 * of the lines a change added, made by rules and not by a model, so the
 * same change gets the same mutants and the same score on every run.
 *
 * A mutant is one added line of a source file (tests aren't mutated, nor
 * comments or the insides of strings) with one rule applied: a comparison,
 * logical or arithmetic operator flipped (`===` to `!==`, `<` to `>=`,
 * `&&` to `||`, `+` to `-`), a boolean literal flipped, an `if` negated or
 * dropped (`if (false)`), a member dropped from a list of literals, or a
 * returned value replaced (`null`, or `None`). They are plain text rules,
 * for JavaScript, TypeScript and Python mostly, so a mutant the build
 * rejects counts as killed, and an equivalent one as survived.
 *
 * At most `max` mutants run: the ones whose hash with the seed sorts first,
 * which depends on the mutant and the seed only, so adding a line elsewhere
 * doesn't move the others. Each runs the repository's test commands in a
 * scratch checkout; the first command to fail, or the mutant timing out
 * (an endless loop), kills it.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "./grade.mjs";

const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|php|c|cc|cpp|h|hpp)$/;
const TEST =
  /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.|(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go)$/;

/** `[from, to]` operators, each flipped where it stands between spaces. */
const SWAPS = [
  ["===", "!=="],
  ["!==", "==="],
  ["==", "!="],
  ["!=", "=="],
  ["<=", ">"],
  [">=", "<"],
  ["<", ">="],
  [">", "<="],
  ["&&", "||"],
  ["||", "&&"],
  ["and", "or"],
  ["or", "and"],
  ["+", "-"],
  ["-", "+"],
].map(([from, to]) => ({
  from,
  to,
  pattern: new RegExp(`(?<= )${from.replace(/[|+]/g, "\\$&")}(?= )`, "g"),
}));
const BOOLEANS = [
  ["true", "false"],
  ["false", "true"],
  ["True", "False"],
  ["False", "True"],
].map(([from, to]) => ({
  from,
  to,
  pattern: new RegExp(`\\b${from}\\b`, "g"),
}));
const LITERAL = String.raw`"[^"\\\n]*"|'[^'\\\n]*'|-?\d+(?:\.\d+)?`;
const LITERAL_SET = new RegExp(
  String.raw`\[\s*((?:${LITERAL})(?:\s*,\s*(?:${LITERAL}))+)\s*,?\s*\]`,
  "g",
);

/** For each character of `text`, whether it is code: outside strings and a trailing comment. */
function codeMask(text, hash) {
  const mask = Array(text.length).fill(false);
  let open = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (open) {
      if (c === "\\") i++;
      else if (c === open) open = null;
    } else if (c === '"' || c === "'" || c === "`") open = c;
    else if ((c === "/" && text[i + 1] === "/") || (hash && c === "#")) break;
    else mask[i] = true;
  }
  return mask;
}

/** The index of the `)` closing the `(` at `at`, or -1. */
function closing(text, mask, at) {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (!mask[i]) continue;
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Whether `text` closes every bracket it opens, within its code. */
function balanced(text, mask) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (!mask[i]) continue;
    if ("([{".includes(text[i])) depth++;
    else if (")]}".includes(text[i]) && --depth < 0) return false;
  }
  return depth === 0;
}

/** Every mutant of one source line, `{ rule, line }`, in a fixed order. */
export function lineMutants(file, text) {
  const python = file.endsWith(".py");
  const mask = codeMask(text, python);
  const code = (from, to) => mask[from] && mask[to - 1];
  const out = [];
  const replace = (rule, from, to, by) =>
    out.push({
      rule,
      line: `${text.slice(0, from)}${by}${text.slice(to)}`,
    });
  for (const { from, to, pattern } of [...SWAPS, ...BOOLEANS])
    for (const match of text.matchAll(pattern))
      if (code(match.index, match.index + from.length))
        replace(`${from} to ${to}`, match.index, match.index + from.length, to);
  for (const match of text.matchAll(LITERAL_SET)) {
    if (!code(match.index, match.index + match[0].length)) continue;
    const members = match[1].match(new RegExp(LITERAL, "g"));
    for (const [i, member] of members.entries())
      replace(
        `drop ${member}`,
        match.index,
        match.index + match[0].length,
        `[${members.filter((_, j) => j !== i).join(", ")}]`,
      );
  }
  if (python) {
    const guard = /^(\s*)(if|elif) (.+):\s*$/.exec(text);
    if (guard && mask[guard[1].length]) {
      const [, indent, keyword, cond] = guard;
      out.push(
        { rule: "negate if", line: `${indent}${keyword} not (${cond}):` },
        { rule: "drop if", line: `${indent}${keyword} False:` },
      );
    }
    const ret = /^(\s*)return (.+)$/.exec(text);
    if (ret && ret[2] !== "None" && balanced(text, mask))
      out.push({ rule: "return None", line: `${ret[1]}return None` });
    return out;
  }
  for (const match of text.matchAll(/\bif\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const close = closing(text, mask, open);
    if (!mask[match.index] || close === -1) continue;
    const cond = text.slice(open + 1, close);
    replace("negate if", open, close + 1, `(!(${cond}))`);
    replace("drop if", open, close + 1, "(false)");
  }
  const ret = /^(\s*)return\s+(.+?);\s*$/.exec(text);
  if (
    /\.(?:[cm]?[jt]sx?)$/.test(file) &&
    ret &&
    !["null", "undefined"].includes(ret[2]) &&
    balanced(text, mask)
  )
    out.push({ rule: "return null", line: `${ret[1]}return null;` });
  return out;
}

/** The lines `base`..`commit` added to source files that aren't tests: `{ file, line, text }`. */
export function addedLines(repo, base, commit) {
  const diff = execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "core.quotepath=off",
      "diff",
      "-U0",
      "--no-color",
      "--no-ext-diff",
      "--no-renames",
      base,
      commit,
    ],
    { encoding: "utf8", maxBuffer: 1 << 28 },
  );
  const lines = [];
  let file = null;
  let line = 0;
  for (const text of diff.split("\n")) {
    if (text.startsWith("+++ ")) {
      const path = text.slice(4).replace(/\t.*$/, "");
      file = path.startsWith("b/") ? path.slice(2) : null;
      if (file && (!SOURCE.test(file) || TEST.test(file))) file = null;
    } else if (text.startsWith("@@")) line = Number(/\+(\d+)/.exec(text)[1]);
    else if (text.startsWith("+")) {
      if (file) lines.push({ file, line, text: text.slice(1) });
      line++;
    }
  }
  return lines;
}

/**
 * The mutants to run: every mutant of the lines `base`..`commit` added,
 * `{ id, file, line, rule, text }` (`text` the mutated line), the `max` that
 * sort first by a hash of the mutant and `seed`, in file and line order.
 */
export function chooseMutants(repo, base, commit, { max, seed }) {
  const all = addedLines(repo, base, commit)
    .filter(({ text }) => !/^\s*(?:\/\/|\/\*|\*|#)/.test(text))
    .flatMap(({ file, line, text }) =>
      lineMutants(file, text).map((m, i) => ({
        id: `${file}:${line}:${i}`,
        file,
        line,
        rule: m.rule,
        text: m.line,
      })),
    );
  const rank = (m) =>
    createHash("sha256").update(`${seed}\0${m.id}\0${m.text}`).digest("hex");
  return all
    .toSorted((a, b) => (rank(a) < rank(b) ? -1 : 1))
    .slice(0, max)
    .toSorted((a, b) =>
      a.file === b.file
        ? a.line - b.line || a.id.localeCompare(b.id)
        : a.file.localeCompare(b.file),
    );
}

/**
 * Run `mutants` in `tree` (a scratch checkout of the graded commit), each
 * against the `tests` commands. The tests must pass unmutated; a mutant
 * gets three times that long, and 30 s, before it counts as an endless loop
 * and is killed. Returns `{ status, results }`: `done`, `failing` (a test
 * command fails on the graded commit, so nothing is measured) or `timeout`
 * (`deadline`, a time in ms, came first); `results` are the mutants, each
 * with `result` `killed` or `survived`, and `by`, the command that killed it.
 */
export async function runMutants(
  tree,
  mutants,
  { tests, env, deadline, groups },
) {
  /** The first command to fail within `ms`, or null: `{ command, timedOut }`. */
  const failure = async (ms) => {
    const end = Date.now() + ms;
    for (const command of tests) {
      const step = await runCommand(command, {
        cwd: tree,
        env,
        timeoutMs: Math.max(end - Date.now(), 1),
        groups,
      });
      if (step.code !== 0) return { command, timedOut: step.timedOut };
    }
    return null;
  };
  const started = Date.now();
  const unmutated = await failure(deadline - started);
  if (unmutated)
    return {
      status: Date.now() >= deadline ? "timeout" : "failing",
      results: [],
      command: unmutated.command,
    };
  const limit = 3 * (Date.now() - started) + 30_000;
  const results = [];
  for (const mutant of mutants) {
    if (Date.now() >= deadline) return { status: "timeout", results };
    const path = join(tree, mutant.file);
    const original = readFileSync(path, "utf8");
    const lines = original.split("\n");
    lines[mutant.line - 1] = mutant.text;
    writeFileSync(path, lines.join("\n"));
    let failed;
    try {
      failed = await failure(Math.min(limit, deadline - Date.now()));
    } finally {
      writeFileSync(path, original);
    }
    if (failed?.timedOut && Date.now() >= deadline)
      return { status: "timeout", results };
    results.push({
      ...mutant,
      result: failed ? "killed" : "survived",
      ...(failed ? { by: failed.command } : {}),
    });
  }
  return { status: "done", results };
}
