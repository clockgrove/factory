/**
 * The one way configuration is checked. A section is a spec: each known
 * key with its check, which names the key's type and default. A key the
 * spec doesn't know is refused by name, with a hint when an earlier
 * configuration used it. Every problem is appended, so one load reports
 * them all.
 */
import { isAbsolute, resolve } from "node:path";

/**
 * A key's check: the value, or its default when it is absent. A wrong
 * value appends a problem naming `at`; what it returns then is unused.
 */
export type Check<T> = (value: unknown, at: string, problems: string[]) => T;

export type Spec = Record<string, Check<unknown>>;

export type Checked<S extends Spec> = {
  [K in keyof S]: ReturnType<S[K]>;
};

/** `path.key`, or `key` at the top level. */
const at = (path: string, key: string) => (path ? `${path}.${key}` : key);

export const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The object at `path` checked against `spec`. An absent section takes
 * every default; a value that isn't an object is a problem.
 */
export function section<S extends Spec>(
  value: unknown,
  path: string,
  spec: S,
  problems: string[],
): Checked<S> {
  let given: Record<string, unknown> = {};
  if (isObject(value)) given = value;
  else if (value !== undefined)
    problems.push(`${path || "the configuration"} must be an object`);
  for (const key of Object.keys(given))
    if (!Object.hasOwn(spec, key))
      problems.push(`${at(path, key)} is not a setting`);
  const checked: Record<string, unknown> = {};
  for (const [key, check] of Object.entries(spec)) {
    const entry = check(given[key], at(path, key), problems);
    if (entry !== undefined) checked[key] = entry;
  }
  return checked as Checked<S>;
}

/** A nested section, as a key's check. */
export const object =
  <S extends Spec>(spec: S): Check<Checked<S>> =>
  (value, path, problems) =>
    section(value, path, spec, problems);

/** Absent stays absent; a given value is checked. */
export const optional =
  <T>(check: Check<T>): Check<T | undefined> =>
  (value, path, problems) =>
    value === undefined ? undefined : check(value, path, problems);

/** A non-empty string; required without a default. */
export const text =
  (fallback?: string): Check<string> =>
  (value, path, problems) => {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value === "string" && value.trim()) return value;
    problems.push(`${path} must be a non-empty string`);
    return fallback ?? "";
  };

/** One of `values`; required without a default. */
export const oneOf =
  <T extends string>(values: readonly T[], fallback?: T): Check<T> =>
  (value, path, problems) => {
    if (value === undefined && fallback !== undefined) return fallback;
    if (values.includes(value as T)) return value as T;
    problems.push(`${path} must be one of ${values.join(", ")}`);
    return fallback ?? values[0]!;
  };

/** A whole number from `least` to `most`; required without a default. */
export const whole =
  (
    least: number,
    fallback?: number,
    most = Number.MAX_SAFE_INTEGER,
  ): Check<number> =>
  (value, path, problems) => {
    if (value === undefined && fallback !== undefined) return fallback;
    if (
      Number.isSafeInteger(value) &&
      (value as number) >= least &&
      (value as number) <= most
    )
      return value as number;
    problems.push(
      `${path} must be a whole number ${most === Number.MAX_SAFE_INTEGER ? `of at least ${least}` : `from ${least} to ${most}`}`,
    );
    return fallback ?? least;
  };

export const flag =
  (fallback: boolean): Check<boolean> =>
  (value, path, problems) => {
    if (value === undefined) return fallback;
    if (typeof value === "boolean") return value;
    problems.push(`${path} must be true or false`);
    return fallback;
  };

/** A list of strings, empty by default. */
export const strings: Check<string[]> = (value, path, problems) => {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
    return [...value];
  problems.push(`${path} must be a list of strings`);
  return [];
};

/** Distinct names from `values`; empty allowed only with `empty`. */
export const names =
  <T extends string>(values: readonly T[], empty: boolean): Check<T[]> =>
  (value, path, problems) => {
    if (
      Array.isArray(value) &&
      (empty || value.length > 0) &&
      value.every((entry) => values.includes(entry as T)) &&
      new Set(value).size === value.length
    )
      return value as T[];
    problems.push(`${path} must be distinct names from ${values.join(", ")}`);
    return [];
  };

/** An absolute, normalized path other than `/`. */
export const absolute = (path: unknown): path is string =>
  typeof path === "string" &&
  isAbsolute(path) &&
  resolve(path) === path &&
  path !== "/";

/** A list of absolute, normalized directory paths, empty by default. */
export const directories: Check<string[]> = (value, path, problems) => {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every(absolute)) return [...value];
  problems.push(`${path} must be absolute, normalized directory paths`);
  return [];
};
