// Known Factory bugs the fault suites reproduce, with their diagnoses. Each
// listed test is inverted: it passes while the bug reproduces and fails once
// the bug is fixed, and then its entry must be removed. References like
// (r1 #4) point at the adversarial review behind #515.
//
// Every list is empty: the step conversions (#563, #566, #562) fixed every
// earlier entry. A new entry needs a diagnosis in D and an open P0 issue.

const D = {};

export const DIAGNOSES = D;

/**
 * Expand {DIAGNOSIS_KEY: [test names]} into {test name: {key, text, pattern}}.
 * An inverted known test passes only when its check fails with a message
 * matching the diagnosis pattern; any other failure fails the test. Racy
 * entries may also pass. Both kinds share one duplicate check. `diagnoses`
 * defaults to the list above; the guards pass their own.
 */
export function todos(groups, racy = {}, diagnoses = D) {
  const map = {};
  for (const [entries, isRacy] of [
    [groups, false],
    [racy, true],
  ])
    for (const [key, names] of Object.entries(entries)) {
      if (!diagnoses[key]) throw new Error(`Unknown diagnosis: ${key}`);
      for (const name of names) {
        if (map[name]) throw new Error(`Duplicate known failure: ${name}`);
        map[name] = {
          key,
          ...diagnoses[key],
          ...(isRacy ? { racy: true } : {}),
        };
      }
    }
  return map;
}

export const KNOWN = {
  regular: todos({}),
  "native-stack": todos({}),
  consistency: todos({}),
};
