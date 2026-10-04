# Media contract

## Thumbnails

Each published image under `assets/` has a thumbnail under `thumbs/` with the
same file name. Thumbnails are PNG, at most 64×64 pixels, stored with Git LFS
under the rule `thumbs/*.png filter=lfs diff=lfs merge=lfs -text`.

A thumbnail has a JSON sidecar `thumbs/<name>.json` naming its source image
and generator.

## Gallery manifest

`gallery.json` lists every published image with `path` and `alt`. A listed
image with a thumbnail also has `thumb`.

## Checks

- `node scripts/check-gallery.mjs manifest`
- `node scripts/check-gallery.mjs thumbs`
- `git check-attr filter -- thumbs/source.png`
