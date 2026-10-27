/**
 * Whether a workflow that runs after the operator's delivery.baseRerun
 * workflow (`on: workflow_run`) skips every job for a run of it that
 * Factory dispatched (#2098). GitHub starts such a follower for every
 * completed run, its `github.event.workflow_run.event` then
 * `workflow_dispatch`; a follower that releases only from a push (as
 * Clockgrove's "Guarded release" does) guards each job with an `if` on it.
 * GitHub starts a follower of that follower too, even when every job of
 * its run was skipped, with `github.event.workflow_run.event`
 * `workflow_run` (facts.ts `baseRerunWorkflow` reads each in turn).
 *
 * Readiness reads the jobs' `if` expressions with only what that start
 * makes certain (`github.event_name` is `workflow_run`, and
 * `github.event.workflow_run.event` is `workflow_dispatch`); every other
 * context value and function result is unknown, and logic over unknowns
 * stays unknown unless the known part decides it (three-valued). A job is
 * skipped when its `if` is certainly false, or when it needs a skipped job
 * and its `if` calls no status function (`success()` is then implied, and
 * false). Anything Factory can't read (an expression it can't parse, a
 * condition mixed with text) counts as running.
 */

/** A known value, or an unknown one whose truthiness may be known. */
type Value =
  | { value: string | number | boolean | null }
  | { value?: undefined; truthy?: boolean };

const STATUS_FUNCTIONS = ["success", "always", "failure", "cancelled"];

/**
 * What a follower knows for certain of the run it follows: GitHub starts
 * it with `workflow_run`, and that run's own event (`workflow_dispatch`
 * for a run Factory dispatched, `workflow_run` for a follower's run).
 */
function known(event: string): Record<string, string> {
  return {
    "github.event_name": "workflow_run",
    "github.event.workflow_run.event": event,
  };
}

type Token =
  | { kind: "string"; text: string }
  | { kind: "number"; value: number }
  | { kind: "name"; text: string }
  | { kind: "op"; text: string };

function tokens(source: string): Token[] {
  const out: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const rest = source.slice(at);
    const space = /^\s+/.exec(rest);
    if (space) {
      at += space[0].length;
      continue;
    }
    if (rest.startsWith("'")) {
      let text = "";
      let end = 1;
      for (;;) {
        if (end >= rest.length) throw new Error("unterminated string");
        if (rest[end] === "'") {
          if (rest[end + 1] === "'") {
            text += "'";
            end += 2;
            continue;
          }
          break;
        }
        text += rest[end];
        end += 1;
      }
      out.push({ kind: "string", text });
      at += end + 1;
      continue;
    }
    const number = /^(0x[0-9a-f]+|\d+(\.\d+)?(e[+-]?\d+)?)/i.exec(rest);
    if (number) {
      out.push({ kind: "number", value: Number(number[0]) });
      at += number[0].length;
      continue;
    }
    const name = /^[a-z_][a-z0-9_-]*/i.exec(rest);
    if (name) {
      out.push({ kind: "name", text: name[0] });
      at += name[0].length;
      continue;
    }
    const op = /^(==|!=|<=|>=|&&|\|\||[<>!()[\].,*])/.exec(rest);
    if (!op) throw new Error(`unexpected ${rest[0]}`);
    out.push({ kind: "op", text: op[0] });
    at += op[0].length;
  }
  return out;
}

function truth(value: Value): boolean | undefined {
  if (value.value === undefined)
    return "truthy" in value ? value.truthy : undefined;
  const known = value.value;
  return !(
    known === false ||
    known === null ||
    known === "" ||
    known === 0 ||
    Number.isNaN(known)
  );
}

function numeric(value: string | number | boolean | null): number {
  if (value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  return value.trim() === "" ? 0 : Number(value);
}

/** GitHub's `==`: strings ignore case; other types compare as numbers. */
function equal(
  a: string | number | boolean | null,
  b: string | number | boolean | null,
): boolean {
  if (typeof a === "string" && typeof b === "string")
    return a.toLowerCase() === b.toLowerCase();
  if (a === null || b === null) return a === b || numeric(a) === numeric(b);
  if (typeof a === typeof b) return a === b;
  return numeric(a) === numeric(b);
}

/** Evaluate `source` three-valued; `status` is set when it calls a status function. */
function evaluate(
  source: string,
  certain: Record<string, string>,
): { value: Value; status: boolean } {
  const list = tokens(source);
  let at = 0;
  let status = false;
  const peek = () => list[at];
  const isOp = (text: string) => {
    const next = peek();
    return next?.kind === "op" && next.text === text;
  };
  const expect = (text: string) => {
    if (!isOp(text)) throw new Error(`expected ${text}`);
    at += 1;
  };
  const or = (): Value => {
    let left = and();
    while (isOp("||")) {
      at += 1;
      const right = and();
      const known = truth(left);
      if (known === true) continue;
      if (known === false) left = right;
      else left = truth(right) === true ? { truthy: true } : {};
    }
    return left;
  };
  const and = (): Value => {
    let left = equality();
    while (isOp("&&")) {
      at += 1;
      const right = equality();
      const known = truth(left);
      if (known === false) continue;
      if (known === true) left = right;
      else left = truth(right) === false ? { truthy: false } : {};
    }
    return left;
  };
  const equality = (): Value => {
    let left = relation();
    while (isOp("==") || isOp("!=")) {
      const negate = isOp("!=");
      at += 1;
      const right = relation();
      left =
        left.value !== undefined && right.value !== undefined
          ? { value: equal(left.value, right.value) !== negate }
          : {};
    }
    return left;
  };
  const relation = (): Value => {
    let left = unary();
    while (isOp("<") || isOp("<=") || isOp(">") || isOp(">=")) {
      at += 1;
      unary();
      left = {};
    }
    return left;
  };
  const unary = (): Value => {
    if (isOp("!")) {
      at += 1;
      const known = truth(unary());
      return known === undefined ? {} : { value: !known };
    }
    return primary();
  };
  const primary = (): Value => {
    const next = peek();
    if (!next) throw new Error("unexpected end");
    at += 1;
    if (next.kind === "string") return { value: next.text };
    if (next.kind === "number") return { value: next.value };
    if (next.kind === "op") {
      if (next.text !== "(") throw new Error(`unexpected ${next.text}`);
      const inner = or();
      expect(")");
      return inner;
    }
    const lower = next.text.toLowerCase();
    if (lower === "true") return { value: true };
    if (lower === "false") return { value: false };
    if (lower === "null") return { value: null };
    if (isOp("(")) {
      at += 1;
      if (STATUS_FUNCTIONS.includes(lower)) status = true;
      if (!isOp(")")) {
        or();
        while (isOp(",")) {
          at += 1;
          or();
        }
      }
      expect(")");
      return {};
    }
    // A context path: only exact property names can be known.
    let path: string | undefined = lower;
    for (;;) {
      if (isOp(".")) {
        at += 1;
        const property = peek();
        at += 1;
        if (property?.kind === "name")
          path = path && `${path}.${property.text.toLowerCase()}`;
        else if (property?.kind === "op" && property.text === "*")
          path = undefined;
        else throw new Error("expected a property");
      } else if (isOp("[")) {
        at += 1;
        const index = or();
        expect("]");
        path =
          path && typeof index.value === "string"
            ? `${path}.${index.value.toLowerCase()}`
            : undefined;
      } else break;
    }
    const given = path === undefined ? undefined : certain[path];
    return given === undefined ? {} : { value: given };
  };
  const value = or();
  if (at !== list.length) throw new Error("unexpected trailing input");
  return { value, status };
}

/** A job's `if` as a run Factory dispatched starts it: certainly false, or not. */
function condition(
  raw: unknown,
  certain: Record<string, string>,
): { never: boolean; status: boolean } {
  if (raw === undefined || raw === null) return { never: false, status: false };
  if (typeof raw === "boolean") return { never: !raw, status: false };
  if (typeof raw === "number") return { never: raw === 0, status: false };
  if (typeof raw !== "string") return { never: false, status: true };
  const trimmed = raw.trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(trimmed);
  const source = wrapped ? wrapped[1]! : trimmed;
  // Text around an expression is a string, always truthy.
  if (source.includes("${{")) return { never: false, status: true };
  try {
    const { value, status } = evaluate(source, certain);
    return { never: truth(value) === false, status };
  } catch {
    return { never: false, status: true };
  }
}

/**
 * Whether every job of `workflow` (a parsed workflow file) is skipped when
 * a run of the workflow it follows that Factory dispatched starts it, or,
 * with `event` `workflow_run`, a run of a follower of that one.
 */
export function skipsDispatchedRuns(
  workflow: unknown,
  event = "workflow_dispatch",
): boolean {
  const certain = known(event);
  const jobs = (workflow as { jobs?: unknown } | null)?.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) return false;
  const all = jobs as Record<string, unknown>;
  const ids = Object.keys(all);
  if (!ids.length) return false;
  const skipped = new Map<string, boolean>();
  const skips = (id: string, seen: Set<string>): boolean => {
    const done = skipped.get(id);
    if (done !== undefined) return done;
    const job = all[id];
    if (!job || typeof job !== "object" || seen.has(id)) return false;
    const { never, status } = condition((job as { if?: unknown }).if, certain);
    const needs = (job as { needs?: unknown }).needs;
    const needed = (Array.isArray(needs) ? needs : [needs]).filter(
      (entry): entry is string => typeof entry === "string" && entry in all,
    );
    const result =
      never ||
      (!status && needed.some((entry) => skips(entry, new Set([...seen, id]))));
    skipped.set(id, result);
    return result;
  };
  return ids.every((id) => skips(id, new Set()));
}
