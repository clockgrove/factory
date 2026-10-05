# Disposable local DAG and lifecycle Objective

## Outcome

Use the installed Factory package to compile three Work Items: independent `alpha-lane` and `beta-lane`, followed by `summary-join`. Run with concurrency 2 and record that both lanes start before either completes, while the join waits for both. Each item must name acceptance, explicit non-goals, owned path, dependencies, and validation provenance.

## Acceptance

- `grep -qx 'alpha lane' alpha.txt`
- `grep -qx 'beta lane' beta.txt`
- `grep -qx 'alpha plus beta' summary.txt`

## Work Items

- `alpha-lane` creates only `alpha.txt` with the line `alpha lane`. No dependencies. Validate with `grep -qx 'alpha lane' alpha.txt`.
- `beta-lane` creates only `beta.txt` with the line `beta lane`. No dependencies. Validate with `grep -qx 'beta lane' beta.txt`.
- `summary-join` depends on both lanes, creates only `summary.txt` with the line `alpha plus beta`, and validates with `grep -qx 'alpha plus beta' summary.txt`.

Non-goals for every item: editing another item's path, deployments, credentials, media, LFS, infrastructure, or Factory source. The lanes have disjoint paths and no shared exclusive resource. The join starts from the exact integrated predecessor head.
