/**
 * The mutation pass (#2344 R5): mutants of the lines a change added, made
 * by rules and not by a model, so the same change gets the same mutants
 * on every run. A result review gets the survivors as evidence of what the
 * item's tests leave unchecked, and the auto-grader scores tests with the
 * same mutants (bench/lib/mutate.mjs).
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
 * doesn't move the others. Each runs the commands in a checkout that
 * passed them unmutated, several at once in checkouts of their own; the
 * first command to fail, or the mutant timing out (an endless loop), kills
 * it.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostLimits } from "../engine.js";
import type { CheckoutCopy, ValidatedCheckout } from "../validate.js";
import { hostGit } from "../worktree.js";

const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|php|c|cc|cpp|h|hpp)$/;
const TEST =
  /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.|(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go)$/;

/** Whether `path` is a test file by its path: in a test directory, or named as a test. */
export const isTestPath = (path: string) => TEST.test(path);

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
  from: from!,
  to: to!,
  pattern: new RegExp(`(?<= )${from!.replace(/[|+]/g, "\\$&")}(?= )`, "g"),
}));
const BOOLEANS = [
  ["true", "false"],
  ["false", "true"],
  ["True", "False"],
  ["False", "True"],
].map(([from, to]) => ({
  from: from!,
  to: to!,
  pattern: new RegExp(`\\b${from}\\b`, "g"),
}));
const LITERAL = String.raw`"[^"\\\n]*"|'[^'\\\n]*'|-?\d+(?:\.\d+)?`;
const LITERAL_SET = new RegExp(
  String.raw`\[\s*((?:${LITERAL})(?:\s*,\s*(?:${LITERAL}))+)\s*,?\s*\]`,
  "g",
);

/** One rule applied to one added line: `text` is the mutated line. */
export interface Mutant {
  id: string;
  file: string;
  line: number;
  rule: string;
  text: string;
}

/** For each character of `text`, whether it is code: outside strings and a trailing comment. */
function codeMask(text: string, hash: boolean): boolean[] {
  const mask: boolean[] = Array(text.length).fill(false);
  let open: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
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
function closing(text: string, mask: boolean[], at: number): number {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (!mask[i]) continue;
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Whether `text` closes every bracket it opens, within its code. */
function balanced(text: string, mask: boolean[]): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (!mask[i]) continue;
    if ("([{".includes(text[i]!)) depth++;
    else if (")]}".includes(text[i]!) && --depth < 0) return false;
  }
  return depth === 0;
}

/** Every mutant of one source line, `{ rule, line }`, in a fixed order. */
export function lineMutants(
  file: string,
  text: string,
): { rule: string; line: string }[] {
  const python = file.endsWith(".py");
  const mask = codeMask(text, python);
  const code = (from: number, to: number) => mask[from] && mask[to - 1];
  const out: { rule: string; line: string }[] = [];
  const replace = (rule: string, from: number, to: number, by: string) =>
    out.push({ rule, line: `${text.slice(0, from)}${by}${text.slice(to)}` });
  for (const { from, to, pattern } of [...SWAPS, ...BOOLEANS])
    for (const match of text.matchAll(pattern))
      if (code(match.index, match.index + from.length))
        replace(`${from} to ${to}`, match.index, match.index + from.length, to);
  for (const match of text.matchAll(LITERAL_SET)) {
    if (!code(match.index, match.index + match[0].length)) continue;
    const members = match[1]!.match(new RegExp(LITERAL, "g")) ?? [];
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
    if (guard && mask[guard[1]!.length]) {
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
    !["null", "undefined"].includes(ret[2]!) &&
    balanced(text, mask)
  )
    out.push({ rule: "return null", line: `${ret[1]}return null;` });
  return out;
}

/** The lines `base`..`commit` added to source files that aren't tests. */
export async function addedLines(
  repo: string,
  base: string,
  commit: string,
  signal?: AbortSignal,
): Promise<{ file: string; line: number; text: string }[]> {
  const diff = (
    await hostGit(
      repo,
      [
        "-c",
        "core.quotepath=off",
        "diff",
        "-U0",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        base,
        commit,
      ],
      signal ? { signal } : {},
    )
  ).toString("utf8");
  const lines: { file: string; line: number; text: string }[] = [];
  let file: string | null = null;
  let line = 0;
  for (const text of diff.split("\n")) {
    if (text.startsWith("+++ ")) {
      const path = text.slice(4).replace(/\t.*$/, "");
      file = path.startsWith("b/") ? path.slice(2) : null;
      if (file && (!SOURCE.test(file) || TEST.test(file))) file = null;
    } else if (text.startsWith("@@")) line = Number(/\+(\d+)/.exec(text)![1]);
    else if (text.startsWith("+")) {
      if (file) lines.push({ file, line, text: text.slice(1) });
      line++;
    }
  }
  return lines;
}

/**
 * The mutants to run: every mutant of the lines `base`..`commit` added,
 * the `max` that sort first by a hash of the mutant and `seed`, in file
 * and line order. `of`: the added lines, when the caller read them.
 */
export async function chooseMutants(
  repo: string,
  base: string,
  commit: string,
  { max, seed }: { max: number; seed: string },
  of?: readonly { file: string; line: number; text: string }[],
): Promise<Mutant[]> {
  const all = (of ?? (await addedLines(repo, base, commit)))
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
  const rank = (m: Mutant) =>
    createHash("sha256").update(`${seed}\0${m.id}\0${m.text}`).digest("hex");
  return [...all]
    .sort((a, b) => (rank(a) < rank(b) ? -1 : 1))
    .slice(0, max)
    .sort((a, b) =>
      a.file === b.file
        ? a.line - b.line || a.id.localeCompare(b.id)
        : a.file.localeCompare(b.file),
    );
}

/** How one command ended. */
export interface MutantRun {
  exitCode: number | null;
  timedOut: boolean;
}

/** One mutant's result: `by` is the command that killed it. */
export type MutantResult = Mutant & {
  result: "killed" | "survived";
  by?: string;
};

/** Where mutants run: a checkout of the measured commit, and how a command runs there. */
export interface MutantLane {
  tree: string;
  /** `signal`, when given, stops the command, which then rejects. */
  run(
    command: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<MutantRun>;
}

/**
 * Run `mutants` against the `tests` commands, the lanes at once, each
 * taking the next mutant, writing it in its own checkout, running the
 * commands until the first that fails (which kills it), and restoring the
 * file. The tests must pass unmutated: with `passing` the caller knows
 * they do (validation passed them), else they run once first in the first
 * lane. A mutant gets three times `baselineMs` (or the first run's time),
 * and 30 s, before it counts as an endless loop and is killed; with
 * `passing` and no `baselineMs`, only the deadline bounds it. Returns
 * `done`, `failing` (a test command fails on the commit, so nothing is
 * measured, with that `command`) or `timeout` (`deadline`, a time in ms,
 * came first) or `stopped` (`signal` aborted: its running commands are
 * stopped and their mutants not counted), with the mutants measured so
 * far, in mutant order.
 */
export async function runMutants(
  lanes: readonly MutantLane[],
  mutants: readonly Mutant[],
  {
    tests,
    deadline,
    baselineMs,
    passing = false,
    signal,
  }: {
    tests: readonly string[];
    deadline: number;
    baselineMs?: number;
    passing?: boolean;
    signal?: AbortSignal;
  },
): Promise<{
  status: "done" | "failing" | "timeout" | "stopped";
  results: MutantResult[];
  command?: string;
}> {
  /** The first command to fail in `lane` within `ms`, or null. */
  const failure = async (lane: MutantLane, ms: number) => {
    const end = Date.now() + ms;
    for (const command of tests) {
      const step = await lane.run(
        command,
        Math.max(end - Date.now(), 1),
        signal,
      );
      if (step.exitCode !== 0 || step.timedOut)
        return { command, timedOut: step.timedOut };
    }
    return null;
  };
  let baseline = baselineMs;
  if (baseline === undefined && !passing) {
    const started = Date.now();
    const unmutated = await failure(lanes[0]!, deadline - started);
    if (unmutated)
      return {
        status: Date.now() >= deadline ? "timeout" : "failing",
        results: [],
        command: unmutated.command,
      };
    baseline = Date.now() - started;
  }
  const limit =
    baseline === undefined ? Number.POSITIVE_INFINITY : 3 * baseline + 30_000;
  const measured = new Map<Mutant, MutantResult>();
  let next = 0;
  let late = false;
  const lane = async (at: MutantLane) => {
    while (next < mutants.length) {
      if (signal?.aborted) return;
      if (Date.now() >= deadline) {
        late = true;
        return;
      }
      const mutant = mutants[next++]!;
      const path = join(at.tree, mutant.file);
      const original = await readFile(path, "utf8");
      const lines = original.split("\n");
      lines[mutant.line - 1] = mutant.text;
      await writeFile(path, lines.join("\n"));
      let failed: Awaited<ReturnType<typeof failure>>;
      try {
        failed = await failure(at, Math.min(limit, deadline - Date.now()));
      } catch (error) {
        // Stopped: this mutant isn't measured.
        if (signal?.aborted) return;
        throw error;
      } finally {
        await writeFile(path, original);
      }
      if (failed?.timedOut && Date.now() >= deadline) {
        late = true;
        return;
      }
      measured.set(mutant, {
        ...mutant,
        result: failed ? "killed" : "survived",
        ...(failed ? { by: failed.command } : {}),
      });
    }
  };
  await Promise.all(lanes.map(lane));
  return {
    status: signal?.aborted ? "stopped" : late ? "timeout" : "done",
    results: mutants.flatMap((mutant) => {
      const result = measured.get(mutant);
      return result ? [result] : [];
    }),
  };
}

/** A surviving mutant, as a result review sees it: the mutated line. */
export interface Survivor {
  file: string;
  line: number;
  rule: string;
  text: string;
}

/** A Work Item's mutation pass over its passed result (`mutationPass`). */
export interface MutationPass {
  /**
   * `skipped`: nothing to mutate, or the pass is off; `timeout`: its time
   * ran out first; `stopped`: its caller stopped it (the review had its
   * verdicts), with the mutants measured so far.
   */
  status: "done" | "timeout" | "skipped" | "stopped";
  /** Why it was skipped or cut short, for the review. */
  note?: string;
  /** Mutants chosen, and of those measured, killed and survived. */
  seeded: number;
  killed: number;
  survived: number;
  survivors: Survivor[];
  ms: number;
}

/**
 * The result review's mutation pass over a passed result: at most
 * `limits.max` mutants of the lines `base`..`commit` added to product
 * files, each run against `commands` (the item's own, after the exact
 * install) within `limits.ms` of wall time. Mutants never install again:
 * they run in copies of `checkout`, which validation's install filled
 * (validate.ts `ValidatedCheckout.copy`), one lane a copy: one always, and
 * one more for each validation slot free on the host (engine.ts
 * `hostLimits`), taken without waiting and released at the end, at most
 * one a mutant; a run with throwaway services has one lane, since its
 * copies share them. `baselineMs`, the commands' time when validation
 * passed them, bounds each mutant (`runMutants`). Skipped, with a note,
 * when the result changed no product file or the pass is off. An abort of
 * `signal` stops it promptly, every running command with it: it resolves
 * `stopped`, with what it measured, and its copies are still removed.
 */
export async function mutationPass(input: {
  checkout: ValidatedCheckout;
  repo: string;
  base: string;
  commit: string;
  commands: readonly string[];
  limits: { max: number; ms: number };
  baselineMs?: number;
  seed: string;
  signal: AbortSignal;
  log(event: Record<string, unknown>): void;
}): Promise<MutationPass> {
  const started = Date.now();
  let lanes = 1;
  const done = (pass: Omit<MutationPass, "ms">): MutationPass => {
    const result = { ...pass, ms: Date.now() - started };
    input.log({
      event: "mutation-pass",
      status: result.status,
      seeded: result.seeded,
      killed: result.killed,
      survived: result.survived,
      lanes,
      ms: result.ms,
    });
    return result;
  };
  const none = { seeded: 0, killed: 0, survived: 0, survivors: [] };
  if (input.limits.max <= 0 || input.limits.ms <= 0)
    return done({
      status: "skipped",
      note: "The mutation pass is off in this installation.",
      ...none,
    });
  if (!input.commands.length)
    return done({
      status: "skipped",
      note: "The item has no validation command to run mutants against.",
      ...none,
    });
  const stopped = () =>
    done({
      status: "stopped",
      note: "The review had its verdicts before the pass began.",
      ...none,
    });
  if (input.signal.aborted) return stopped();
  const added = await addedLines(input.repo, input.base, input.commit);
  if (!added.length)
    return done({
      status: "skipped",
      note: "The result changed no product source file, so no mutant was seeded.",
      ...none,
    });
  const mutants = await chooseMutants(
    input.repo,
    input.base,
    input.commit,
    { max: input.limits.max, seed: input.seed },
    added,
  );
  if (!mutants.length)
    return done({
      status: "skipped",
      note: "No line the result added to a product file could be mutated.",
      ...none,
    });
  const wanted = input.checkout.services ? 1 : mutants.length;
  while (lanes < wanted && hostLimits.acquire("cpu")) lanes += 1;
  const copies: CheckoutCopy[] = [];
  let ran: Awaited<ReturnType<typeof runMutants>>;
  try {
    for (let lane = 0; lane < lanes && !input.signal.aborted; lane++)
      copies.push(await input.checkout.copy(`mutant-${lane}`));
    if (input.signal.aborted) return stopped();
    ran = await runMutants(
      copies.map((copy) => ({
        tree: copy.directory,
        run: (command, timeoutMs, signal) =>
          copy.run(command, timeoutMs, signal),
      })),
      mutants,
      {
        tests: input.commands,
        deadline: started + input.limits.ms,
        passing: true,
        signal: input.signal,
        ...(input.baselineMs !== undefined && {
          baselineMs: input.baselineMs,
        }),
      },
    );
  } finally {
    for (let lane = 1; lane < lanes; lane++) hostLimits.release("cpu");
    await Promise.all(copies.map((copy) => copy.remove()));
  }
  const survivors = ran.results
    .filter((result) => result.result === "survived")
    .map(({ file, line, rule, text }) => ({ file, line, rule, text }));
  const killed = ran.results.length - survivors.length;
  return done({
    status: ran.status === "failing" ? "done" : ran.status,
    ...(ran.status === "timeout" && {
      note: `The pass ran out of its ${Math.round(input.limits.ms / 1000)} s before the last mutant: ${ran.results.length} of ${mutants.length} were measured.`,
    }),
    ...(ran.status === "stopped" && {
      note: `The review had its verdicts first: ${ran.results.length} of ${mutants.length} mutants were measured.`,
    }),
    seeded: mutants.length,
    killed,
    survived: survivors.length,
    survivors,
  });
}
