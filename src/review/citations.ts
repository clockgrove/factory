/**
 * The file:line citations in a reviewer's words, and which paths are
 * tests: result review merges refusals that cite overlapping lines
 * (review/item.ts `mergedRefusals`), its protected-test check counts test
 * files' assertions, and escalation (review/escalation.ts) compares the
 * files a repro and a pass cite and tells product code from tests.
 */

/**
 * A file:line citation in a refusal's detail: `path:N`, `path:N-M`, or a
 * list `path:N-M,P-Q`, a `#L` anchor too (`path#L3-L5`).
 */
const CITATION =
  /(?<![\w./@+-])([\w.@+-][\w./@+-]*)(?::|#L)(\d+(?:-L?\d+)?(?:,\s*L?\d+(?:-L?\d+)?)*)(?![\w-])/g;

/**
 * The line spans `detail` cites: each by its file's path, `candidate/` or
 * `./` aside, and its basename.
 */
export function citedSpans(detail: string) {
  return [...detail.matchAll(CITATION)].flatMap(([, cited, ranges]) => {
    const path = cited!.replace(/^(\.\/|candidate\/)+/, "");
    const file = path.split("/").pop()!;
    // A bare number with a colon ("note:3") names no file.
    if (!file.includes(".")) return [];
    return ranges!.split(",").map((range) => {
      const [start, end] = range
        .replace(/L/g, "")
        .split("-")
        .map((n) => Number(n.trim()));
      const [from, to] = [start!, end ?? start!].sort((a, b) => a - b);
      return { path, file, start: from!, end: to! };
    });
  });
}

/** Whether two cited spans are of one file: the same path, or the same basename when neither names a directory. */
export const sameFile = (
  one: ReturnType<typeof citedSpans>[number],
  other: ReturnType<typeof citedSpans>[number],
) =>
  one.path.includes("/") || other.path.includes("/")
    ? one.path === other.path
    : one.file === other.file;

/** A test file by its path: under a test directory, or a `.test.` or `.spec.` name. */
export const TEST_PATH = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\./;

/** Whether a word of `text` is a test file's path (`TEST_PATH`). */
export const namesTestPath = (text: string) =>
  text.split(/[\s`'"(),;<>[\]]+/).some((word) => TEST_PATH.test(word));
