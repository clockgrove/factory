# Thumbnail for the reference image

## Goal

Add a thumbnail for `assets/source.png` as `docs/MEDIA.md#Thumbnails`
specifies, and list it in `gallery.json`.

## Acceptance

- `.gitattributes` adds the rule
  `thumbs/*.png filter=lfs diff=lfs merge=lfs -text` and keeps the existing
  rule.
- The worker produces two candidate thumbnail sets from repository source
  asset `assets/source.png` (role `reference`, `image/png`, repository
  visibility). Each set has an `image` role bound to `thumbs/source.png`
  and a `metadata` role bound to `thumbs/source.json`. The `image` role
  requires LFS. A human selects one set.
- `gallery.json` gives the reference image `"thumb": "thumbs/source.png"`.
- `node scripts/check-gallery.mjs thumbs` passes.
- `node scripts/check-gallery.mjs manifest`

## Planning sources

- `docs/MEDIA.md#Thumbnails`
- `docs/MEDIA.md#Gallery manifest`

## Final validation

- `node scripts/check-gallery.mjs thumbs`
- `git check-attr filter -- thumbs/source.png | grep -qx 'thumbs/source.png: filter: lfs'`

## Non-goals

- Changing `assets/source.png` or committing candidate bytes directly.

Factory separately verifies that a fresh clone and `git lfs pull` hydrate
the selected thumbnail.
