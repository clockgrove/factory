# Disposable combined release-candidate gate

## Outcome

Use one disposable Objective and this public fixture to prove an immutable installed Factory package across concurrent independent local work, native stack delivery, a harness-declared multi-file AssetSet, human selection, target-owned Git LFS, and exact final-head validation. The target fixture supplies `assets/source.png`; every other requirement is in this issue. Keep the seven Work Items and their dependencies exactly as listed.

## Acceptance

- `grep -qx 'release candidate left' release/left.txt`
- `grep -qx 'release candidate right' release/right.txt`
- `grep -qx 'release stack foundation' release/stack/foundation.txt`
- `grep -qx 'release stack middle' release/stack/middle.txt`
- `grep -qx 'release stack top' release/stack/top.txt`
- `git check-attr filter -- release/media/selected.png | grep -qx 'release/media/selected.png: filter: lfs'`
- `test -s release/media/selected.png && test -s release/media/selected.json`
- `git lfs ls-files | grep -q 'release/media/selected.png'`

## Work Items

1. `rc-left` owns only `release/left.txt`, has no dependencies, and writes the single line `release candidate left`. Validate with `grep -qx 'release candidate left' release/left.txt`.
2. `rc-right` owns only `release/right.txt`, has no dependencies, and writes the single line `release candidate right`. Validate with `grep -qx 'release candidate right' release/right.txt`. `rc-left` and `rc-right` have separate paths and resources. The configured local concurrency is two; both worker attempts must start from the same Objective base before either result is integrated.
3. `rc-stack-foundation` depends on both `rc-left` and `rc-right`, owns only `release/stack/foundation.txt`, and writes the single line `release stack foundation`. Validate with `grep -qx 'release stack foundation' release/stack/foundation.txt`.
4. `rc-stack-middle` depends only on `rc-stack-foundation`, owns only `release/stack/middle.txt`, and writes the single line `release stack middle`. Validate with `grep -qx 'release stack middle' release/stack/middle.txt`.
5. `rc-stack-top` depends only on `rc-stack-middle`, owns only `release/stack/top.txt`, and writes the single line `release stack top`. Validate with `grep -qx 'release stack top' release/stack/top.txt`. Items 3–5 form one maximal native linear stack with three PR layers and exact predecessor bases.
6. `rc-lfs-policy` depends on both `rc-left` and `rc-right`, changes only `.gitattributes`, and adds the path rule `release/media/*.png filter=lfs diff=lfs merge=lfs -text`. Validate with `git check-attr filter -- release/media/selected.png | grep -qx 'release/media/selected.png: filter: lfs'`.
7. `rc-selected-asset` depends on both `rc-stack-top` and `rc-lfs-policy`, owns only `release/media/selected.png` and `release/media/selected.json`, and binds repository source `assets/source.png` as role `reference`, media type `image/png`, and repository visibility. Its expected output roles are `image` and `metadata`; the minimum candidate count is two and the `image` role requires LFS. The configured Codex harness must declare two complete AssetSets with different image bytes, each with source, rights basis, repository visibility, and lineage. Stage candidate bytes under `.factory-media/<candidate-id>/`; bind both roles to the two owned destinations. Each JSON sidecar identifies its own candidate and source. A human reviews and selects one entire set through the installed CLI. Validate with `test -s release/media/selected.png && test -s release/media/selected.json` and `git lfs ls-files | grep -q 'release/media/selected.png'`.

Every Work Item needs explicit acceptance, non-goals, source citations, path ownership, and command provenance in the compiled graph. Do not modify another item's path or `assets/source.png`. Do not add deployment, credentials, providers, recovery mechanisms, or Factory source. Workers do not commit, publish, or bypass the human selection flow.
