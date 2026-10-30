## Goal

Add a small expense ledger to the drill library: a parser and formatter for ledger lines in `src/ledger{{ID}}.js`, a report built on them in `src/report{{ID}}.js`, and a short user note in `docs/ledger{{ID}}.md`. Each module has its own test, `test/ledger{{ID}}.test.js` and `test/report{{ID}}.test.js`. A ledger line is `<date> <item> <amount>`, separated by single spaces. No other file changes.

## Acceptance

- `parseEntry{{ID}}("2026-01-05 coffee 3.50")` returns `{ date: "2026-01-05", item: "coffee", cents: 350 }`.
- `parseEntry{{ID}}("2026-01-05 bagel 2")` returns `{ date: "2026-01-05", item: "bagel", cents: 200 }`: a whole amount needs no decimals.
- `parseEntry{{ID}}("2026-02-01 oat-milk 0.05")` returns `{ date: "2026-02-01", item: "oat-milk", cents: 5 }`.
- `parseEntry{{ID}}("coffee 3.50")` throws an `Error` whose message is exactly `ledger: expected "<date> <item> <amount>", got "coffee 3.50"`.
- `parseEntry{{ID}}("01/05/2026 tea 1")` throws an `Error` whose message is exactly `ledger: bad date "01/05/2026"`.
- `parseEntry{{ID}}("2026-01-05 tea 3.999")` throws an `Error` whose message is exactly `ledger: bad amount "3.999"`, and the amounts `-1` and `1,50` throw `ledger: bad amount "-1"` and `ledger: bad amount "1,50"`.
- `cents` is always an integer: `parseEntry{{ID}}("2026-01-05 tea 0.29").cents` is `29`, never `28.999999999999996`.
- `formatEntry{{ID}}({ date: "2026-01-05", item: "coffee", cents: 350 })` returns exactly `2026-01-05 coffee $3.50`.
- `formatEntry{{ID}}` always prints two decimals and no thousands separator: cents `5` print as `$0.05`, `200` as `$2.00` and `123456` as `$1234.56`.
- `report{{ID}}(lines)` returns one string: each entry formatted by `formatEntry{{ID}}`, in input order, then a last line `TOTAL $<sum>`, joined with `\n` and no trailing newline.
- `report{{ID}}(["2026-01-05 coffee 3.50", "2026-01-06 bagel 2"])` returns exactly `"2026-01-05 coffee $3.50\n2026-01-06 bagel $2.00\nTOTAL $5.50"`.
- `report{{ID}}([])` returns exactly `"TOTAL $0.00"`.
- `report{{ID}}` skips empty lines and lines whose first character is `#`: `report{{ID}}(["# January", "", "2026-01-05 tea 1"])` returns exactly `"2026-01-05 tea $1.00\nTOTAL $1.00"`.
- `report{{ID}}` stops at the first line it can't parse and throws an `Error` whose message is the parser's message prefixed with that line's 1-based position in the input: `report{{ID}}(["2026-01-05 tea 1", "01/05/2026 tea 1"])` throws exactly `line 2: ledger: bad date "01/05/2026"`.
- `report{{ID}}` is a real consumer of the parser, not a stub: it imports `parseEntry{{ID}}` and `formatEntry{{ID}}` from `./ledger{{ID}}.js` and sums the parsed cents, and `test/report{{ID}}.test.js` proves it with amounts only the parser can convert (`"1.05"` and `"0.95"` total `$2.00`), so a report that echoes its input lines or returns a fixed total fails that test.
- `test/ledger{{ID}}.test.js` asserts every example and exact message above for `parseEntry{{ID}}` and `formatEntry{{ID}}`, and `test/report{{ID}}.test.js` every example and exact message above for `report{{ID}}`.
- `docs/ledger{{ID}}.md` has an `## Errors` section that lists, one per line in a code block, every distinct message form `parseEntry{{ID}}` and `report{{ID}}` throw, exactly as they throw them, with `<...>` placeholders for the variable parts.
- `docs/ledger{{ID}}.md` has an `## Example` section whose input lines and output, each in a code block, are exactly what the integrated `report{{ID}}` returns for those lines.
- `npm test` passes.

## Constraints

- Each Work Item that adds a module runs `npm test` in its validation, and that run proves the behaviour criteria of the module it adds.
