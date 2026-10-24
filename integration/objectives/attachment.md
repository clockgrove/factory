## Goal

Add `docs/attachment{{ID}}.md`, a short note that records the byte size, SHA-256 and PNG width and height of the screenshot attached at {{ATTACHMENT_URL}} (role: reference screenshot), computed from the exact bytes Factory gives the worker as an input. Also add `test/attachment{{ID}}.test.js`, which checks that the note states a byte count, a 64-character lower-case hex sha256, and a width and height that are positive integers. No other file changes.

## Acceptance

- `docs/attachment{{ID}}.md` states the attachment's bytes, sha256, width and height.
- `npm test`
