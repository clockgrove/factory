# textkit specification

## Slug

`slug(text)` lowercases `text`, replaces each run of characters outside
`[a-z0-9]` with one `-`, and trims leading and trailing `-`.

## Wrap

`wrap(text, width)` splits `text` on single spaces and greedily packs words
into lines of at most `width` characters, joined with `\n`. A word longer
than `width` sits alone on its own line. `width` must be a positive integer;
otherwise `wrap` throws a `RangeError`.

## Truncate

`truncate(text, max)` returns `text` unchanged when it has at most `max`
characters. Otherwise it returns the first `max - 1` characters followed by
`…` (U+2026), so the result has exactly `max` characters. `max` must be an
integer of at least 1; otherwise `truncate` throws a `RangeError`.

## Command line

`bin/textkit.mjs` is the `textkit` command. It reads standard input and
applies one subcommand:

- `textkit slug` prints `slug(input)`.
- `textkit wrap WIDTH` prints `wrap(input, WIDTH)`.
- `textkit truncate MAX` prints `truncate(input, MAX)`.

An unknown subcommand prints usage to standard error and exits 2.

## Documentation

`docs/CLI.md` documents every subcommand with one example each.

## Checks

- `node scripts/check.mjs slug`
- `node scripts/check.mjs wrap`
- `node scripts/check.mjs truncate`
- `node scripts/check.mjs cli`
- `node scripts/check.mjs docs`
- `npm test`
