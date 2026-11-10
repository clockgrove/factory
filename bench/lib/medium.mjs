// The medium drill set (bench/drill.mjs --set medium): five Objectives of real size over the scratch adopter's notes
// CLI, each in the adopter's repository alone, adding files at a discovered extension point.

/** The medium set, each `(sfx)`. */
export const MEDIUM = [
  (sfx) => ({
    title: `Add the ${sfx} export format to notes list`,
    body: `## Goal
A caller can list notes as plain lines: \`notes list --format ${sfx}\` prints one line per note.

## Acceptance
- \`src/export/${sfx}.mjs\` exports \`format(rows)\`: one line per note in the order of \`rows\` as \`<id><TAB><title><TAB><tags joined by ;>\`, lines joined by newlines, no trailing newline, an empty list giving an empty string.
- \`notes list --format ${sfx}\` reaches it through discovery; no discovery module changes.
- \`test/${sfx}.export.test.mjs\` proves two rows and the empty list with exact values under \`node:test\`.
- \`test/db/${sfx}.db.test.mjs\` adds two notes on a fresh schema (\`test/db/helpers.mjs\`) and proves the format over \`list()\`.
- \`npm run check\`, \`npm test\` and \`npm run test:db\` pass; no other file changes.

## Sources
- \`src/export/json.mjs\`, \`src/export/table.mjs\`, \`test/export.test.mjs\`, \`test/db/notes.db.test.mjs\` (the patterns)
- \`AGENTS.md\`

## Context
Filed by the Factory adopter drill (bench/drill.mjs, medium set) at ${new Date().toISOString()}. Recorded decision: tags are joined by a semicolon with no spaces; the tab is U+0009; titles and tags are printed as stored, with no escaping.
`,
  }),
  (sfx) => ({
    title: `Add the ${sfx} command: the newest titles in one line`,
    body: `## Goal
A caller can see the newest note titles at a glance: \`notes ${sfx} --limit N\` prints the N most recent titles in one line.

## Acceptance
- \`src/commands/${sfx}.mjs\` exports \`run(client, args)\`: parses \`--limit\` with \`node:util\` \`parseArgs\` (default 5), returns the newest N titles joined by \` | \` (space, bar, space), newest first; an empty store returns an empty string.
- The limit rule: \`--limit\` is plain decimal digits (\`/^\\d+$/\`) with a value from 1 to 2147483647. Any other value (\`0\`, \`+5\`, \`5.0\`, \`1e1\`, \` 5\`), a \`--limit\` with no value, an unknown option or a positional argument throws an error with \`code\` \`BAD_ARGS\` before any query.
- \`test/${sfx}.command.test.mjs\` proves \`BAD_ARGS\` for \`--limit 0\`, \`--limit 1e1\` and an unknown option without a database under \`node:test\`.
- \`test/db/${sfx}.db.test.mjs\` adds three notes on a fresh schema and proves order and the limit with exact values.
- \`npm run check\`, \`npm test\` and \`npm run test:db\` pass; no other file changes.

## Sources
- \`src/commands/list.mjs\`, \`src/commands/remove.mjs\`, \`src/notes.mjs\`, \`test/db/notes.db.test.mjs\` (the patterns; \`list.mjs\` and \`remove.mjs\` for the file's shape only: their parsing is looser than the limit rule above, and they do not change)
- \`AGENTS.md\`

## Context
Filed by the Factory adopter drill (bench/drill.mjs, medium set) at ${new Date().toISOString()}. Recorded decision: the separator is exactly one space, one vertical bar, one space; \`list()\` from \`src/notes.mjs\` supplies the rows.
`,
  }),
  (sfx) => ({
    title: `Add a ${sfx}_count column with a bump-${sfx} command`,
    body: `## Goal
A note can carry a counter: \`notes bump-${sfx} <id>\` increments it and prints the new value.

## Acceptance
- A new migration \`migrations/${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}_${sfx}.sql\` adds \`${sfx}_count INTEGER NOT NULL DEFAULT 0\` to \`notes\`; no existing migration changes.
- \`src/commands/bump-${sfx}.mjs\` exports \`run(client, args)\`: increments \`${sfx}_count\` for the note whose id is \`args[0]\` and returns \`#<id> ${sfx}_count=<new value>\`; an unknown id returns \`no note #<id>\`.
- The id rule: \`args[0]\` is plain decimal digits with an optional leading minus (\`/^-?\\d+$/\`), read as given with no option parsing. A missing \`args[0]\` or any other value (\`1.5\`, \`1e2\`, \`0x10\`, \`+7\`, \` 7\`, an empty string) throws with \`code\` \`BAD_ID\`. An id outside int4 (-2147483648 to 2147483647) returns \`no note #<id>\` without a query, never a database error. \`<id>\` in both lines is \`args[0]\` as given; arguments after it are ignored.
- \`test/db/${sfx}.db.test.mjs\` proves on a fresh schema: a new note starts at 0, two bumps give 2, an unknown id and the id \`2147483648\` each give the no-note line, and \`BAD_ID\` for a missing id and for \`1e2\`.
- \`npm run check\`, \`npm test\` and \`npm run test:db\` pass; no other file changes.

## Sources
- \`migrations/20261106000000_notes.sql\`, \`src/db.mjs\`, \`src/commands/remove.mjs\`, \`test/db/helpers.mjs\` (the patterns; \`remove.mjs\` for the file's shape only: its id parsing is looser than the id rule above, and it does not change)
- \`AGENTS.md\`

## Context
Filed by the Factory adopter drill (bench/drill.mjs, medium set) at ${new Date().toISOString()}. Recorded decision: the counter is a plain \`INTEGER\` column with no cap in code; a bump past 2147483647 is out of scope, so the database error there stands; the migration name's timestamp prefix is the one given above.
`,
  }),
  (sfx) => ({
    title: `Add the ${sfx} rule: titles may not contain the word ${sfx}`,
    body: `## Goal
A note whose title contains the word \`${sfx}\` is refused at \`notes add\`.

## Acceptance
- \`src/rules/${sfx}.mjs\` exports \`code\` \`${sfx.toUpperCase()}\` and \`check(note)\`: returns \`title contains ${sfx}\` when a whitespace-separated word of the title equals \`${sfx}\` ignoring case, else null. Punctuation is part of a word, so \`${sfx}.\` passes, as does a longer word that contains \`${sfx}\`.
- \`test/${sfx}.rule.test.mjs\` proves the word, the word in another case, a longer word containing it, and a missing title under \`node:test\` without a database.
- \`test/db/${sfx}.db.test.mjs\` proves on a fresh schema that \`add()\` rejects a title containing the word with that code and accepts one without it.
- \`npm run check\`, \`npm test\` and \`npm run test:db\` pass; no other file changes.

## Sources
- \`src/rules/title-required.mjs\`, \`src/rules.mjs\`, \`test/db/notes.db.test.mjs\` (the patterns)
- \`AGENTS.md\`

## Context
Filed by the Factory adopter drill (bench/drill.mjs, medium set) at ${new Date().toISOString()}. Recorded decision: a missing title is the title-required rule's business, so \`check\` returns null for a non-string title.
`,
  }),
  (sfx) => ({
    title: `Add the ${sfx} command: similarity search within a tag`,
    body: `## Goal
A caller can find the nearest notes among those carrying a tag: \`notes ${sfx} --tag T --embedding 1,2,3 [--k N]\`.

## Acceptance
- \`src/commands/${sfx}.mjs\` exports \`run(client, args)\`: finds the \`k\` notes that carry \`tag\` and have an embedding, nearest first by Euclidean distance then by id ascending, and returns one line per note as \`#<id> <title> (<distance>)\` with the distance from \`toFixed(3)\`, lines joined by newlines with no trailing newline; no matching note returns an empty string. \`src/notes.mjs\` does not change; calling a function it already exports is fine.
- The argument rule, parsed with \`parseArgs\`: \`--tag\` is a non-empty string; \`--embedding\` is exactly three comma-separated numbers, each matching \`/^-?\\d+(\\.\\d+)?$/\` and, read with \`Number()\`, at most 3.4e38 in absolute value (the float4 range pgvector stores); \`--k\` is plain decimal digits (\`/^\\d+$/\`) from 1 to 2147483647, default 3. A missing or empty \`--tag\` or \`--embedding\`, any other \`--embedding\` or \`--k\` value, an option with no value, an unknown option, a positional argument or any other error \`parseArgs\` throws gives an error with \`code\` \`BAD_ARGS\` before any query, never a database error. An embedding that starts with a minus must be written \`--embedding=-1,2,3\`: \`parseArgs\` refuses \`--embedding -1,2,3\` as ambiguous, so that form is \`BAD_ARGS\`.
- \`test/db/${sfx}.db.test.mjs\` proves on a fresh schema: a tagged near note comes first, an untagged nearer note is excluded, and \`k\` caps the rows.
- \`test/${sfx}.command.test.mjs\` proves \`BAD_ARGS\` without a database for a missing \`--tag\`, a missing \`--embedding\`, the embedding \`1,2\`, \`--embedding -1,2,3\`, an embedding number above 3.4e38 and \`--k 0\`.
- \`npm run check\`, \`npm test\` and \`npm run test:db\` pass; no other file changes.

## Sources
- \`src/notes.mjs\` (\`similar\`), \`src/commands/similar.mjs\`, \`test/db/notes.db.test.mjs\` (the patterns; \`similar.mjs\` for the file's shape only: its parsing is looser than the argument rule above, and it does not change)
- \`AGENTS.md\`

## Context
Filed by the Factory adopter drill (bench/drill.mjs, medium set) at ${new Date().toISOString()}. Recorded decision: the tag filter is \`tag = ANY(tags)\`; distance is pgvector's \`<->\`.
`,
  }),
];

/** `count` medium Objectives, suffixed `m<stamp><i>`. */
export const mediumObjectives = (count, stamp) =>
  Array.from({ length: count }, (_, i) => {
    const fn = `m${stamp}${i}`;
    const o = MEDIUM[i % MEDIUM.length](fn);
    return { title: o.title, body: o.body, fn };
  });
