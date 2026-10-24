## Goal

Add `docs/inputs{{ID}}.md`, a short table that records, for each of the two source inputs below, its role, its byte size and its SHA-256, computed from the exact bytes Factory gives the worker as inputs:

- The repository file `assets/red.png` (role: reference image).
- The private local file `{{FIXTURES}}/private-brief.txt` (role: brief). Also quote its label word in the table.

Also add `test/inputs{{ID}}.test.js`, which checks that the table has a row for each input, that the `assets/red.png` row's byte size and sha256 match that file's bytes in the checkout (CI hydrates Git LFS), and that the brief's row has a 64-character lower-case hex sha256 and quotes its label word. No other file changes.

## Acceptance

- `docs/inputs{{ID}}.md` has one row per input with role, bytes and sha256 matching the input bytes.
- `npm test`
