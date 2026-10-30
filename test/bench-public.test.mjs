// The benchmark harness is public: it ships no benchmark's private data.
// Definitions, results and real run logs live outside this repository
// (bench/lib/home.mjs); the tests run on an invented Objective.
//
// This is an allow-list, so it names nothing private: every repository,
// issue, date and commit that a file under bench/ or test/fixtures/bench/,
// or a bench test, names must be one of the invented ones below or Factory's
// own. Words that no pattern can tell apart (the private repository's Work
// Items, its people) are kept out by the bench home's private-words.txt,
// which stays in the private repository with the benchmark's data.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HOME_ENV } from "../bench/lib/home.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The invented Objective and its run: acme/widgets#42, in 2031. */
const INVENTED = {
  // OWNER is the placeholder of usage text (OWNER/NAME, OWNER__NAME).
  owners: new Set(["acme", "OWNER"]),
  issues: new Set([42]),
  year: "2031",
  commits: new Set(["0123456789abcdef0123456789abcdef01234567"]),
};

/** Factory's own repository and the issues of it that the harness cites. */
const FACTORY = {
  repository: "clockgrove/factory",
  issues: new Set([2168, 2200, 2223]),
};

const allowedRepository = (owner, name) =>
  INVENTED.owners.has(owner) || `${owner}/${name}` === FACTORY.repository;

const allowedIssue = (owner, name, issue) =>
  owner === undefined
    ? INVENTED.issues.has(issue) || FACTORY.issues.has(issue)
    : `${owner}/${name}` === FACTORY.repository
      ? FACTORY.issues.has(issue)
      : INVENTED.owners.has(owner) && INVENTED.issues.has(issue);

/** Every repository, issue, date or commit in `text` that isn't allowed. */
function violations(text) {
  const found = [];
  const each = (pattern, check) => {
    for (const match of text.matchAll(pattern))
      if (!check(match)) found.push(match[0]);
  };
  const slug = (match) =>
    allowedRepository(match[1], match[2].replace(/\.git$/, ""));
  // Repositories: URLs, API paths, OWNER__NAME state directories, package
  // scopes and the fields that hold one.
  each(/github\.com[/:]([\w.-]+)\/([\w.-]+)/g, slug);
  each(/\brepos\/([\w.-]+)\/([\w.-]+)/g, slug);
  each(/\b([A-Za-z0-9][A-Za-z0-9.-]*)__([\w.-]+)/g, slug);
  each(/(?<![\w.])@([\w-]+)\/([\w.-]+)/g, slug);
  each(
    /\b(?:repository|repo|nameWithOwner|full_name|fullName)"?\s*:\s*"([\w.-]+)\/([\w.-]+)"/g,
    slug,
  );
  each(/\bowner"?\s*:\s*"([^"]*)"/g, (match) => INVENTED.owners.has(match[1]));
  // Issues: OWNER/NAME#N, a bare #N (not a CSS colour) and issue fields.
  each(/\b([A-Za-z0-9][\w.-]*)\/([\w.-]+)#(\d+)\b/g, (match) =>
    allowedIssue(match[1], match[2], Number(match[3])),
  );
  each(/(?<![\w:&/#-])#(\d+)(?!\w)/g, (match) =>
    allowedIssue(undefined, undefined, Number(match[1])),
  );
  each(/\bissue"?\s*:\s*"?(\d+)/g, (match) =>
    allowedIssue(undefined, undefined, Number(match[1])),
  );
  // Dates: every timestamp is the invented run's.
  each(
    /(?<!\d)(\d{4})-\d{2}-\d{2}(?!\d)/g,
    (match) => match[1] === INVENTED.year,
  );
  // Commits: only the invented ones.
  each(/(?<![0-9a-fA-F])[0-9a-f]{40}(?![0-9a-fA-F])/g, (match) =>
    INVENTED.commits.has(match[0]),
  );
  return found;
}

function files(dir) {
  return readdirSync(dir, { recursive: true })
    .map((path) => join(dir, path))
    .filter((path) => statSync(path).isFile());
}

const scanned = [
  ...files(join(root, "bench")),
  ...files(join(root, "test", "fixtures", "bench")),
  ...readdirSync(join(root, "test"))
    .filter((name) => name.startsWith("bench-"))
    .map((name) => join(root, "test", name)),
];

test("the guard sees a repository, issue, date or commit that isn't invented", () => {
  // Built from parts so that this file's own scan doesn't find them; every
  // one is invented.
  const person = ["some", "one"].join("");
  const other = `${person}/else`;
  const sha = "f".repeat(40);
  const text = [
    `https://github.com/${other}.git`,
    `${other}#${7}`,
    "acme/widgets#42 and https://github.com/acme/widgets.git",
    `see #${7}, not #42 or #2200; --good:#006300`,
    `{"issue": ${7}, "owner": ${JSON.stringify(person)}}`,
    `${2026}-01-02T00:00:00Z, not 2031-03-04`,
    sha,
    `${person}__else`,
  ].join("\n");
  assert.deepEqual(violations(text), [
    `github.com/${other}.git`,
    `${person}__else`,
    `owner": ${JSON.stringify(person)}`,
    `${other}#${7}`,
    `#${7}`,
    `issue": ${7}`,
    `${2026}-01-02`,
    sha,
  ]);
});

test("bench/ and its fixtures name only invented repositories, issues, dates and commits", () => {
  assert.ok(scanned.length > 10, `scanned only ${scanned.length} files`);
  const found = [];
  for (const file of scanned)
    for (const value of violations(readFileSync(file, "utf8")))
      found.push(`${relative(root, file)}: ${value}`);
  assert.deepEqual(found, []);
});

test("bench/ and its fixtures hold none of the bench home's private words", (t) => {
  const home = process.env[HOME_ENV];
  const list = home ? join(home, "private-words.txt") : null;
  if (!list || !existsSync(list)) {
    t.skip(
      `no ${HOME_ENV}/private-words.txt: the private words of a benchmark are checked only where its bench home is`,
    );
    return;
  }
  // [line number, word]; # starts a comment.
  const words = readFileSync(list, "utf8")
    .split("\n")
    .map((line, index) => [index + 1, line.trim().toLowerCase()])
    .filter(([, word]) => word && !word.startsWith("#"));
  assert.ok(words.length > 0, `${list} lists no words`);
  const found = [];
  for (const file of scanned) {
    const text = readFileSync(file, "utf8").toLowerCase();
    // The word's line in the list, never the word: this output is public too.
    for (const [line, word] of words)
      if (text.includes(word))
        found.push(`${relative(root, file)}: private-words.txt line ${line}`);
  }
  assert.deepEqual(found, []);
});
