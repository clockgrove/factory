# Better alt text

## Goal

Replace the alt text of `assets/source.png` in `gallery.json` with
`"Two-by-two reference pattern"`. This is a metadata change; no image
changes.

## Acceptance

- `gallery.json` lists `assets/source.png` with alt text
  `Two-by-two reference pattern`.
- `node scripts/check-gallery.mjs manifest` passes.

## Final validation

- `node scripts/check-gallery.mjs manifest`

## Non-goals

- Adding, changing or regenerating any image, thumbnail or LFS rule.
