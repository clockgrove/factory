# Quality tooling

Factory uses Biome for repository-owned TypeScript linting and for every file
format that Biome supports. Narrow ESLint and Prettier checks remain only where
Biome 2.5.14 does not provide equivalent coverage. The public `npm run lint`,
`npm run format:check`, and `npm run format` interfaces stay stable.

## Version and scope

`@biomejs/biome` is pinned exactly to `2.5.14`. At migration time, that was the
npm `latest` release and the matching signed upstream release. The selection was
checked against the official [release](https://github.com/biomejs/biome/releases/tag/%40biomejs%2Fbiome%402.5.14),
[migration guide](https://biomejs.dev/guides/migrate-eslint-prettier/), and
[rule-source index](https://biomejs.dev/linter/rules-sources/).

Biome's official migrator found 88 rules in the combined ESLint presets and
mapped 81. After the TypeScript preset's core-rule overrides, 66 rules were
effective for `src/**/*.ts`. The table below maps that effective surface.
`biome.json` keeps the migrated rules explicit with `preset: "none"` so an
upstream recommended-preset change cannot silently alter Factory's gate.

## Effective lint mapping

| Previous ESLint rule                                                                       | Current check                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `for-direction`                                                                            | `lint/correctness/useValidForDirection`           |
| `no-async-promise-executor`                                                                | `lint/suspicious/noAsyncPromiseExecutor`          |
| `no-case-declarations`                                                                     | `lint/correctness/noSwitchDeclarations`           |
| `no-compare-neg-zero`                                                                      | `lint/suspicious/noCompareNegZero`                |
| `no-cond-assign`                                                                           | `lint/suspicious/noAssignInExpressions`           |
| `no-constant-binary-expression`                                                            | `lint/suspicious/noConstantBinaryExpressions`     |
| `no-constant-condition`                                                                    | `lint/correctness/noConstantCondition`            |
| `no-control-regex`                                                                         | `lint/suspicious/noControlCharactersInRegex`      |
| `no-debugger`                                                                              | `lint/suspicious/noDebugger`                      |
| `no-delete-var`                                                                            | Biome parser rejects invalid delete targets       |
| `no-dupe-else-if`                                                                          | `lint/suspicious/noDuplicateElseIf`               |
| `no-duplicate-case`                                                                        | `lint/suspicious/noDuplicateCase`                 |
| `no-empty`, `no-empty-static-block`                                                        | `lint/suspicious/noEmptyBlockStatements`          |
| `no-empty-character-class`                                                                 | `lint/correctness/noEmptyCharacterClassInRegex`   |
| `no-empty-pattern`                                                                         | `lint/correctness/noEmptyPattern`                 |
| `no-ex-assign`                                                                             | `lint/suspicious/noCatchAssign`                   |
| `no-extra-boolean-cast`                                                                    | `lint/complexity/noExtraBooleanCast`              |
| `no-fallthrough`                                                                           | `lint/suspicious/noFallthroughSwitchClause`       |
| `no-global-assign`                                                                         | `lint/suspicious/noGlobalAssign`                  |
| `no-irregular-whitespace`                                                                  | `lint/suspicious/noIrregularWhitespace`           |
| `no-loss-of-precision`                                                                     | `lint/correctness/noPrecisionLoss`                |
| `no-misleading-character-class`                                                            | `lint/suspicious/noMisleadingCharacterClass`      |
| `no-nonoctal-decimal-escape`                                                               | `lint/correctness/noNonoctalDecimalEscape`        |
| `no-octal`                                                                                 | Biome parser and `npm run typecheck`              |
| `no-prototype-builtins`                                                                    | `lint/suspicious/noPrototypeBuiltins`             |
| `no-regex-spaces`                                                                          | `lint/complexity/noAdjacentSpacesInRegex`         |
| `no-self-assign`                                                                           | `lint/correctness/noSelfAssign`                   |
| `no-shadow-restricted-names`                                                               | `lint/suspicious/noShadowRestrictedNames`         |
| `no-sparse-arrays`                                                                         | `lint/suspicious/noSparseArray`                   |
| `no-unsafe-finally`                                                                        | `lint/correctness/noUnsafeFinally`                |
| `no-unsafe-optional-chaining`                                                              | `lint/correctness/noUnsafeOptionalChaining`       |
| `no-unused-labels`                                                                         | `lint/correctness/noUnusedLabels`                 |
| `no-unused-private-class-members`                                                          | `lint/correctness/noUnusedPrivateClassMembers`    |
| `no-useless-backreference`                                                                 | `lint/suspicious/noUselessRegexBackrefs`          |
| `no-useless-catch`                                                                         | `lint/complexity/noUselessCatch`                  |
| `no-useless-escape`                                                                        | Biome for regex; ESLint for strings and templates |
| `require-yield`                                                                            | `lint/correctness/useYield`                       |
| `use-isnan`                                                                                | `lint/correctness/useIsNan`                       |
| `valid-typeof`                                                                             | `lint/correctness/useValidTypeof`                 |
| `no-var`                                                                                   | `lint/suspicious/noVar`                           |
| `prefer-const`                                                                             | `lint/style/useConst`                             |
| `prefer-rest-params`                                                                       | `lint/complexity/noArguments`                     |
| `prefer-spread`                                                                            | `lint/style/useSpreadOverApply`                   |
| `@typescript-eslint/no-array-constructor`                                                  | `lint/style/useArrayLiterals`                     |
| `@typescript-eslint/no-duplicate-enum-values`                                              | `lint/suspicious/noDuplicateEnumValues`           |
| `@typescript-eslint/no-empty-object-type`                                                  | Biome for `{}`; ESLint for empty interfaces       |
| `@typescript-eslint/no-unsafe-function-type`, `@typescript-eslint/no-wrapper-object-types` | `lint/complexity/noBannedTypes`                   |
| `@typescript-eslint/no-explicit-any`                                                       | `lint/suspicious/noExplicitAny`                   |
| `@typescript-eslint/no-extra-non-null-assertion`                                           | `lint/suspicious/noExtraNonNullAssertion`         |
| `@typescript-eslint/no-misused-new`                                                        | `lint/suspicious/noMisleadingInstantiator`        |
| `@typescript-eslint/no-namespace`                                                          | `lint/style/noNamespace`                          |
| `@typescript-eslint/no-non-null-asserted-optional-chain`                                   | `lint/suspicious/noNonNullAssertedOptionalChain`  |
| `@typescript-eslint/no-require-imports`                                                    | `lint/style/noCommonJs`                           |
| `@typescript-eslint/no-this-alias`                                                         | `lint/complexity/noUselessThisAlias`              |
| `@typescript-eslint/no-unnecessary-type-constraint`                                        | `lint/complexity/noUselessTypeConstraint`         |
| `@typescript-eslint/no-unsafe-declaration-merging`                                         | `lint/suspicious/noUnsafeDeclarationMerging`      |
| `@typescript-eslint/no-unused-expressions`                                                 | `lint/suspicious/noUnusedExpressions`             |
| `@typescript-eslint/no-unused-vars`                                                        | `lint/correctness/noUnusedVariables`              |
| `@typescript-eslint/prefer-as-const`                                                       | `lint/style/useAsConstAssertion`                  |
| `@typescript-eslint/prefer-namespace-keyword`                                              | `lint/suspicious/useNamespaceKeyword`             |

The focused `eslint.config.js` retains only these effective checks because
Biome 2.5.14 does not implement them or does not match the TypeScript rule's
full directive behavior:

- `no-invalid-regexp`
- `no-unexpected-multiline`
- `no-useless-escape` for string and template literals
- `@typescript-eslint/ban-ts-comment`
- `@typescript-eslint/no-empty-object-type` for empty interfaces
- `@typescript-eslint/triple-slash-reference`

Biome's `lint/suspicious/noTsIgnore` remains enabled as an overlapping check
for `@ts-ignore`, while the ESLint fallback also rejects `@ts-nocheck` and
enforces the TypeScript preset's `@ts-expect-error` description policy. The
focused quality-tooling test exercises every fallback gap and proves that Biome
or TypeScript still reject the three checks removed from ESLint.

The parity audit also probes every non-identical or combined migration in this
effective ruleset: assignments in expressions, `arguments`, `.apply`, banned
TypeScript types, CommonJS imports, `this` aliases, empty blocks, adjacent regex
spaces, and regex escapes. Exact-source mappings use Biome's published
rule-source metadata. The audit found two additional partial mappings:

- `noUselessEscapeInRegex` does not cover useless escapes in string or template
  literals, so that part of `no-useless-escape` remains in ESLint.
- `noBannedTypes` covers the `{}` type, `Function`, and wrapper object types,
  but not empty interfaces or interfaces with only one extension. Those cases
  remain under `@typescript-eslint/no-empty-object-type`.

The migrator also reported `no-new-symbol` as unavailable, but that core rule
was disabled by the previous TypeScript preset; `npm run typecheck` continues
to reject constructing `Symbol`.

The residual ESLint stack is pinned to ESLint 9.39.5 and typescript-eslint
8.44.1 because their Node engine ranges include every supported Node 22
release. Upstream now marks ESLint 9 as out of standard support, but ESLint 10
and newer typescript-eslint transitive dependencies require Node 22.13 or newer
and would contradict Factory's declared and documented `node >=22`
compatibility floor. The compatibility shim is temporary and should disappear
with the remaining Biome parity gaps rather than raising Factory's runtime
floor for a development tool.

Secret scanning is unchanged. Packaged Secretlint remains a production
dependency and still checks changed staged and working bytes before publication;
it is not replaced by either development linter.

## Formatting mapping

Biome formats the repository's JavaScript, TypeScript, JSON configuration, and
test sources using explicit Prettier-compatible baseline options: two spaces,
80 columns, LF endings, double quotes, semicolons, trailing commas, bracket
spacing, and parenthesized arrow parameters. The checked-in migration is then
mechanically formatted once by Biome, so Biome is the source of truth for those
files after the migration.

Prettier remains only for file kinds Biome 2.5.14 does not format here:

- Markdown documentation and installed skill files
- GitHub Actions YAML and other YAML
- `package-lock.json`, which Biome deliberately protects as tool-owned

This is a temporary unsupported-surface fallback, not shared formatter
ownership. It can be removed when the pinned Biome release supports Markdown
and YAML formatting and no longer protects the npm lockfile. Removing it before
then would silently drop formatting enforcement for those files.

`npm run format:check` runs both formatters over their strictly non-overlapping
sets. Biome's Git integration honors `.gitignore`; neither command checks
`dist/` or `node_modules/`.

## Continuous integration

The [Quality workflow](../.github/workflows/quality.yml) runs on every pull request and on `main`. Lint, formatting and notice checks run in one job; the complete test suite runs in four parallel shards with `node --test --test-shard`. Dependencies are restored from a cache keyed by `package-lock.json`. The `package-gate` job passes only when every other job passes, and it is the check `main` requires.
