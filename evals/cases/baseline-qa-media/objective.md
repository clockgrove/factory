# Qualify the gallery manifest

## Goal

Confirm read-only that the gallery manifest is valid at the current base.

## Acceptance

- `node scripts/check-gallery.mjs manifest` passes on the base.

## Planning sources

- `docs/MEDIA.md#Gallery manifest`

## Final validation

- `node scripts/check-gallery.mjs manifest`

## Non-goals

- Any file change, including images and LFS rules.
