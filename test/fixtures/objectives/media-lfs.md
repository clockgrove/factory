# Disposable media and LFS gate

## Outcome

Use the installed Factory package to deliver one human-selected, complete multi-file AssetSet through the ordinary Work Item path. The public repository fixture already contains `assets/source.png`, a real 2×2 PNG. Produce two candidate sets from that source with different image bytes and matching JSON sidecars. The configured Codex harness declares the sets and its evidence; Factory retains and verifies their exact bytes. A human selects one set with the documented CLI. The unselected set never enters the target Git tree.

## Acceptance

- `git check-attr filter -- approved/selected.png | grep -qx 'approved/selected.png: filter: lfs'`
- `test -s approved/selected.png && test -s approved/selected.json`
- `git lfs ls-files | grep -q 'approved/selected.png'`

## Work Items

1. `lfs-policy` changes only `.gitattributes`, adding the reviewed path-based rule `approved/*.png filter=lfs diff=lfs merge=lfs -text`. Validate with `git check-attr filter -- approved/selected.png | grep -qx 'approved/selected.png: filter: lfs'`. Do not add a global binary rule or modify the source image.
2. `selected-asset` depends on `lfs-policy` and owns only `approved/selected.png` and `approved/selected.json`. Bind repository source asset `assets/source.png` as role `reference`, media type `image/png`, and repository visibility; its expected output roles are `image` and `metadata`, its minimum candidate count is two, and the `image` role requires LFS under the target policy. The Codex harness must declare two candidate AssetSets, each with both roles, a source, rights basis, repository visibility, and lineage. Candidate bytes live under `.factory-media/<candidate-id>/` until Factory imports them. Both sets bind the image role to `approved/selected.png` and the metadata role to `approved/selected.json`. The image may be a deterministic edited PNG derived from the source. The sidecar identifies its own candidate and source. A human chooses one complete set. Validate with `test -s approved/selected.png && test -s approved/selected.json` and `git lfs ls-files | grep -q 'approved/selected.png'`. Do not directly commit candidate staging files or bypass Factory selection.

The source path, output roles, validation commands, ownership, dependency, acceptance, and non-goals must appear in the compiled Work Item graph. The `lfs-policy` result is the exact base for `selected-asset`.
