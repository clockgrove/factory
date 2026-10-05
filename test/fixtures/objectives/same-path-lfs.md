# Disposable same-path Git LFS migration gate

## Outcome

Use the installed Factory package to migrate the public fixture's tracked ordinary blob `assets/source.png` to target-owned Git LFS at that exact same path without changing its 77 bytes or SHA-256 digest `886eca293713dd0dc77ee8c492c64e81359f6e0286b79d5f6df20c506466d1e2`. Keep the two Work Items and their dependency exactly as listed. Factory's supplied controller-capability manifest is authoritative for whole-set selection, final-destination materialization, LFS upload before publication, and post-integration fresh-clone hydration; do not create another target Work Item or target command solely to reproduce those controller guarantees.

## Acceptance

- `git check-attr filter -- assets/source.png | grep -qx 'assets/source.png: filter: lfs'`
- `sha256sum assets/source.png | grep -qx '886eca293713dd0dc77ee8c492c64e81359f6e0286b79d5f6df20c506466d1e2  assets/source.png'`
- `git lfs ls-files | grep -q 'assets/source.png'`

## Work Items

1. `same-path-lfs-policy` owns only `.gitattributes`, has no dependencies, and adds the exact path rule `assets/source.png filter=lfs diff=lfs merge=lfs -text`. Validate with `git check-attr filter -- assets/source.png | grep -qx 'assets/source.png: filter: lfs'`. Do not change the image or add a broader rule.
2. `same-path-lfs-migration` depends only on `same-path-lfs-policy` and owns only `assets/source.png`. Bind repository source `assets/source.png` as role `image`, media type `image/png`, and repository visibility. Its only expected output role is `image`, its minimum candidate count is one, and that role requires LFS. The worker must copy the supplied source bytes unchanged to a staged candidate under `.factory-media/`, bind that candidate back to destination `assets/source.png`, and declare its source, rights basis, repository visibility, and lineage in `.factory-assets.json`. The worker must not write, remove, or change the final destination. A human reviews and selects the complete candidate through the installed CLI. Validate with `sha256sum assets/source.png | grep -qx '886eca293713dd0dc77ee8c492c64e81359f6e0286b79d5f6df20c506466d1e2  assets/source.png'` and `git lfs ls-files | grep -q 'assets/source.png'`.

Every Work Item needs explicit acceptance, non-goals, source citations, path ownership, and command provenance in the compiled graph. Do not add deployment, credentials, providers, recovery mechanisms, sidecars, generated variants, or Factory source. Workers do not commit, publish, or bypass human selection.
