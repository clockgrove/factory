# Better alt text

## Outcome

Replace the alt text of `assets/source.png` in `gallery.json` with
`"Two-by-two reference pattern"`. This is a metadata change; no image
changes.

## Acceptance

- `gallery.json` lists `assets/source.png` with alt text
  `Two-by-two reference pattern`.
- `node scripts/check-gallery.mjs manifest`

## Constraints

- Adding, changing or regenerating any image, thumbnail or LFS rule.
