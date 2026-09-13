# Bounded Objective discovery

Accepted for #349 after an independent architecture review against main
`53956bacab38e72fd6cb1f97ba98ec781a407079`, before implementation.

## Failure and selected model

Cold discovery fetched all labelled open and closed issues, hydrated every comment history and
retained lifetime maps. The periodic broad control-ref scan also counted historical graph, lease
and recovery refs against discovery limits. These reads made completed development history an
operational ceiling. The replacement streams filtered metadata and exact outstanding obligations,
retains bounded summaries and hydrates one selected history transiently.

All-age open discovery, recent closed changes and execution/validation capacity claims alone are
insufficient. Compilation and review create model invocation/accounting obligations without a worker
claim, and commands can be acknowledged while the controller is offline. The chosen minimal addition
is an exact-scope locator ref pointing at an existing commit. It carries no duplicate event journal,
policy or usage. Each request ID and admitted run/writer epoch has a distinct immutable name under
`refs/clockgrove-factory/active/`; no historical authority ref is deleted.

An application request comment is authenticated first, then its locator is ensured before returning
acceptance. Exact replay repairs the locator; already-settled requests remain disposed. Before model
or resource effects, a writer registers its lifecycle scope under the Objective lease. Retirement
requires permanent settlement of that scope, including admitted resource and accounting obligations.
Distinct names ensure that settlement cannot delete a newer request or epoch. Unknown terminal
liabilities remain discoverable for inspection and never authorize execution replay. A stale locator
after interrupted final deletion conservatively requires selected inspection, not historical replay.

This avoids a mutable working-set label and its acknowledgement/removal race. Objective labels are
retrieval hints. Extending the capacity journal would mix command/management lifecycle into resource
reservation authority and add unrelated CAS contention. A persisted full cache would retain the
original lifetime cost and fail on cache loss. Neither alternative is needed. No external service or
new database is introduced.

## Actual GitHub API choice

| Operation | REST repository endpoint | Direct GraphQL repository connection |
| --- | --- | --- |
| Issues | `state`, `labels`, `since`; fixed issue records, including PRs | `states`, `labels`, `filterBy.since`; selected issue fields, no search |
| Pages | numbered pages and Link headers, at most 100 records per page | `first:100`, opaque `after`, `pageInfo`; selected nodes |
| Change observation | authenticated ETag/304 for an exact GET representation | ordinary query response; no REST ETag shortcut |
| Cost | REST primary requests; an authenticated 304 consumes no primary point | GraphQL primary points; transport count is a different measure |

The implementation uses GraphQL issue metadata (`number`, `state`, `updatedAt`, comment count and
type) ordered by creation time, plus a separate narrowly prefixed ref connection. Exact issue reads
use conditional REST GET; per-Objective comments use bounded REST pagination. Full issue bodies,
comment histories and unrelated labels are absent from enumeration. REST adapters reject PR-shaped
exact issue responses. Search is not used, so no search cap or delayed search indexing governs
acknowledged work. The official contracts are [repository issues](https://docs.github.com/en/rest/issues/issues#list-repository-issues),
[GraphQL repository connections](https://docs.github.com/en/graphql/reference/repos#repository),
[IssueFilters](https://docs.github.com/en/graphql/reference/issues#issuefilters),
and [conditional requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests).

Two bounded authenticated read-only probes on 2026-09-13 confirmed the current IssueFilters schema,
combined open/label/since query and custom active-ref prefix with alphabetical cursor ordering. Each
empty query reported one GraphQL primary point. These prove the queried API shapes, not populated
pagination behavior, large-repository economics or installed execution. Generated tests separately
exercise populated pages and transport response shapes.

Neither API promises a frozen multi-page snapshot. Each lane keeps one page and a cursor; watermarks
advance only after complete traversal, through the first server response time with two-minute
overlap. Full all-age open scans recur every fifteen minutes. Closed metadata uses a seven-day cold
lookback and bounded recent windows after long downtime. Known running IDs, active capacity IDs and
exact locator scopes remain independent of page membership, state, labels or age. Mutation during a
scan converges through overlap and repeated direct sweeps; no partial scan proves absence. Large
relevant sets take successive bounded cycles, and real quota waits preserve safety and progress.

## Lifecycle and qualification boundaries

| Supported situation | Discovery/settlement rule |
| --- | --- |
| Old open activation, controller offline | All-age open scan; acknowledged request locator |
| Compilation before first claim; review after last release | Writer-epoch locator precedes model effects; unknown usage retains it |
| Closure during admitted work | Known run and exact locators continue inspection/stop handling; closure proves no cleanup |
| Pause/drain/cancel and simultaneous resume | Separate request identities; retire only disposition-proven scope; later resume survives |
| Recovery of selected old Objective | Exact authorized request/plan; existing resource and cumulative-accounting fences |
| Crash before effects | Conservative writer locator; no authority from its mere existence |
| Crash after final claim release | Lifecycle locator still covers accounting and remaining management work |
| Terminal with unknown resources/usage | Inspection diagnostic, no restart; final bookkeeping alone is not a settlement certificate |
| Old settled closed Objective | No routine hydration; reopen or explicitly inspect selected history |

The per-Objective history/byte limits and shared-capacity safety limits remain. Summary and telemetry
caches are bounded and disposable. Removing a summary cannot remove a durable obligation. Malformed
Objective-local evidence is isolated; a real shared-resource or authority failure still fences work.
Legacy capacity initialization remains a separate guarded migration boundary; #349 does not authorize
historical migration or deletion, and ordinary initialized-controller discovery does not invoke it.

Synthetic scale and lifecycle tests establish source behavior. Their request/byte observations are
labelled by measurement scope. Existing #112/#346/#319 evidence remains bound to its own candidate and
scenario; it does not establish the newly requested successive-foundation/extension/restart/regression
scenario. No new model-backed run is authorized by these tests. A matching installed cumulative run
requires its scenario-specific local allowance and fixture disposition before #349 can claim that
acceptance item. Shared Desktop restart, shared plugin replacement and package publication remain
outside this change.
