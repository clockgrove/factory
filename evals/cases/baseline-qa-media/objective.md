# Qualify the gallery manifest

## Outcome

Confirm read-only that the gallery manifest is valid at the current base.

## Acceptance

- `node scripts/check-gallery.mjs manifest` passes on the base.
- `node scripts/check-gallery.mjs manifest`

## Sources

- `docs/MEDIA.md#Gallery manifest`

## Constraints

- Any file change, including images and LFS rules.
