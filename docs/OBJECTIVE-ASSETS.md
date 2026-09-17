# Objective input assets

Factory can import explicit, bounded Objective inputs through `factory_assets_import` and inspect a
previously published manifest through `factory_assets_inspect`. An import is pinned to the selected
repository, Objective, default-branch commit and request ID. It does not scrape issue bodies or
later refetch a lost source.

Accepted sources are an absolute local regular-file path with no symlinked parent, or a recognized
GitHub user attachment URL. GitHub downloads use bounded manual redirects and public-address DNS
pinning. Arbitrary URLs are refused. Every caller must state visibility and a rights basis; public
repositories refuse private inputs and unknown rights.

Content identity is SHA-256 of the exact bytes. Filenames, URLs and local paths are provenance, not
identity, and source paths and URLs are never written into a Worker Packet. Factory classifies
content with `file-type`, fully decodes supported raster formats with `sharp`, and validates inert
UTF-8 text and Markdown without rendering it or following links. Executable and active content is
refused. Other passive formats require the caller to opt in to opaque transport; they receive the
neutral filename `asset.bin` and are not described as semantically valid.

Imports are retained in the same immutable Git-ref content-transfer substrate as worker artifacts.
The intent ref is not usable input. Factory publishes a manifest only after every ready ref exists.
Materialization is offline from those ready refs into private Supervisor-owned staging, verifies
Git and SHA-256 identity, fsyncs, marks files read-only, and atomically installs the completed tree.

The Worker Packet binds assets only by manifest, descriptor, content, storage-receipt digests and
stable relative path. It contains no source location, credential, or mutable download URL. Factory
has one prerelease packet, artifact, transfer, and asset contract; every producer and consumer uses
that same canonical shape.

Current bounds are 32 assets, 100 MiB each, and 256 MiB in aggregate. Raster handling additionally
limits decoded pixels, frame count and decoded bytes. Audio, video, documents and archives remain
opaque unless a future statically registered handler provides semantic validation; opaque retention
does not authorize execution or imply that the content is safe to render.

The classifier (`file-type`, MIT), redirect address parser (`ipaddr.js`, MIT), and raster decoder
(`sharp`, Apache-2.0, with its platform libvips package) are exact lockfile dependencies. Factory
does not reimplement their parsers. The build regenerates third-party notices and bundle inventory;
setup/doctor loads the pinned native decoder so a missing or incompatible platform package is
reported before asset-backed execution. Factory still enforces its own byte, pixel, frame and
aggregate limits around those libraries.

## Compiler media intents

An activation may select one exact imported manifest with `assetManifestDigest` (CLI:
`--asset-manifest-digest`). The activation receipt and `FactoryRunStarted` bind that digest beside
the base commit and run policy, so a retry or resume cannot substitute different bytes. The
`compilerMediaEgress` policy separately controls whether no assets, public assets only, or private
assets may reach the compiler. Factory supplies safe opaque metadata in the structured compiler
request and passes verified media paths separately through a management adapter only when that
adapter advertises the exact media type. The Codex CLI adapter currently maps supported raster
types to its image-input channel. Local paths and media bytes are never embedded in the prompt or
GitHub issue.

The model may return semantic `mediaIntents` for supported media types and producer roles advertised
in the compiler request. Each intent cites Objective obligations and directed Work Item bindings,
declares required or helpful necessity, sets bounded media type and count constraints, optionally
adds a typed raster profile, and requests human review or a policy-authorized deterministic rule.
The model selects one strict fulfillment: exact imported manifest asset IDs, or produced media whose
imported and prior-intent inputs are assigned to capability-advertised roles in
`inputRoleBindings`. Factory resolves those IDs and derives the exact descriptor digests.
For an `evidence-for` binding, the model also selects an expected imported asset, a bounded scenario,
and grounded capture and optional comparison recipe IDs. It cannot author command text, output
roles, MIME authority, comparison policy, providers, models, credentials, stores, URLs, network
access, descriptor digests, or execution authority.

Factory first matches an intent against the selected imported manifest. A matching implementation
reference becomes an exact `assetInputs` binding on the repository Work Item. Otherwise Factory may
derive an `asset-production` Work Item only from an advertised producer capability whose output and
input roles are fully satisfied. That Work Item has a `clockgrove.factory/asset-set` deliverable, no
repository scope, and no validation command. The current produced-media path supplies reviewed
inputs to downstream implementation or decisions. An `evidence-for` intent always remains on its
bound `repository-change` Work Item. Trusted projection resolves `.factory/validation-captures.json`
against commands observed from the pinned checkout and emits a digest-bound
`repositoryCaptureRecipes` entry with the exact intent and criterion references, scenario input,
declared output roles and MIME types, optional typed raster profile, exact-byte or bounded-threshold
comparison with one explicit subject output role, and review gate. Exact-byte comparison has no
comparison command. The subject role names one declared output whose MIME exactly matches the
expected asset and is permitted by the intent. Raster profiles preserve catalog viewport, exact
output dimensions, and role identities and add the intent's width, height, alpha, and animation
acceptance constraints. Catalog exact dimensions and expected asset inspection must satisfy them.
Auxiliary capture, diff, and preview outputs do not count as additional comparison subjects. The
expected bytes reuse one exact `assetInputs` descriptor rather than repeating transport identity in
the recipe. Required unsupported evidence fails compilation with a structured violation; helpful
evidence may be omitted with an explicit trace disposition while its Work Item criteria and
obligations remain.

The committed catalog contains `captures` and `thresholdComparisons`; it has no protocol-version
field or aliases. Every command must already be a repository-observed validation recipe. Its JSON
shape is [`schemas/validation-captures.schema.json`](../schemas/validation-captures.schema.json).
Capture recipes are format-neutral: outputs may be structured JSON, opaque binary, raster, or any
other bounded MIME identity. Runtime trees, artifacts, environments, captured bytes, receipts, and
decisions are execution results and never recipe fields.
Worker validation commands are unique and ordered by phase: ordinary validation first, then all
capture commands, then all threshold comparisons. Reusing command text across phases or recipe
identities is rejected. A human-required capture gate forces semantic review across the bound Work
Item's complete acceptance set.

## Repository-result capture

Repository-result capture is part of independent validation, not a third deliverable type. A
repository Work Item still produces one `clockgrove.factory/artifact`; `evidence-for` recipes observe
that artifact's exact independently validated result tree. Captured files may be JSON, text, audio,
documents, raster output, or other bounded passive bytes. Output roles are recipe-defined semantics,
not a format whitelist. Raster dimensions and alpha/animation constraints are one optional typed
profile implemented by an installed handler. A game or visual-application scenario such as Raccoon
World is a qualification fixture for this composition, not an architecture boundary.

Before capture execution, Factory persists one immutable validation invocation. It binds repository,
Objective, run, Work Item and attempt identity; artifact, base and result-tree identity; ordered
ordinary, capture and comparison commands; recipes and output authorities; expected descriptor,
content and storage-receipt digests; the selected validation environment; and the complete
`repositoryCaptureEgress` policy. A result is an immutable child of that intent. Capture descriptors,
storage receipts, mechanical comparison results and validation evidence all repeat the invocation
digest and artifact/base/result-tree identities. Factory checks the result tree before and after
persisting captured bytes, so a valid capture cannot be paired with a different repository result.

Exact and threshold comparisons use different byte flows. For an exact comparison, the trusted host
compares the captured SHA-256 with the expected content digest; the validator never needs the
expected bytes. A threshold recipe runs its repository-observed comparison command and therefore
receives the expected bytes in private staging. An isolated validator receives only the expected
inputs used by threshold recipes, subject to the validation egress mode, visibility and count bound.
All captured outputs return to the host, are checked against their declared MIME and optional typed
profile, and are retained through immutable `validation-evidence` content transfers. An opaque
unprofiled output may establish an exact byte match, but it carries no semantic-validity claim.

Mechanical validation and semantic review are separate gates. Exact equality, a grounded threshold,
declared content identity and a typed handler check can produce mechanical evidence. When an
acceptance criterion still requires judgment, Factory may materialize the expected and observed
bytes for the independent reviewer only after the immutable review policy and the selected
management adapter's reviewer capability both allow every MIME type, typed profile, semantic handler,
visibility, rights basis, network destination and deduplicated asset count. The files are rehashed,
placed in private read-only staging and supplied separately from the textual prompt. Repository files
and every evidence byte remain untrusted reviewer input. The durable review receipt stays separate
from validation evidence and binds its exact evidence digest and result tree.

`repositoryCaptureEgress.validation` and `repositoryCaptureEgress.review` are independent and deny
external disclosure by default. Compiler input egress does not grant either permission. The
validation count covers only threshold expected inputs sent to a third-party validator. The review
count covers the complete deduplicated expected-plus-observed bundle and additionally requires an
explicit reviewer capability ID. `public-assets` excludes private bytes; `private-assets` permits
both visibility classes but still requires compatible rights, handlers, adapter capabilities and
ordinary network-destination policy.

Recovery observes the exact invocation before considering another launch. Local commands have
durable dispatch and terminal records, and ambiguous dispatch without a terminal record fails closed.
For isolated validation, Factory first recovers retained outputs, downloads and verifies them, and
persists the invocation result and capture evidence. Only then may it delete the provider resource or
reconcile validation capacity. A provider adapter must refuse stale-resource cleanup while it knows
of uncheckpointed captured bytes. Recovery never regenerates evidence or substitutes a new result
tree.

Repository delivery remains independent of capture format. Ordinary bounded outputs are committed as
ordinary Git blobs. In a repository whose pinned base already assigns a changed path to Git LFS,
Factory may use the existing authenticated LFS endpoint as an artifact transport adapter: it retains
the raw bytes in the ordinary content-transfer substrate, uploads and independently reads back the
exact object, then commits the canonical pointer. The artifact binds the assignment, tool, endpoint,
transfer and verification receipts. Factory does not turn an output MIME type or capture profile into
LFS policy, add tracking rules, or route validation evidence through product delivery.

## Produced asset lifecycle

Asset production uses its own adapter contract and never enters the repository artifact, validation,
or pull-request pipeline. The installed route is `sharp/local-raster-derivative-v1`, a deterministic
local PNG derivative producer with no network or paid provider call. Its capability advertises the
`raster-derivative` intent role, a required `source` input role, and private output with unknown
rights. Producer capabilities bind exact input and output MIME types, typed profiles, request and
byte limits, egress, observation, cancellation, result collection, and native usage units. The
compiler receives only the intersection of those registered capabilities with the immutable run
policy. A compiled producer binds both the capability ID and digest, so a later adapter change cannot
silently execute an older graph. It also binds the nonempty activation-selection interval shared by
all downstream consumers; approval cannot select a count outside that interval.

Before dispatch, `AttemptReserved` and the issue admission ledger bind the complete media invocation:
the run, Work Item, attempt, intent and Worker Packet digests, adapter capability, exact inputs,
model, quality, typed profile, deadline, policy, egress, and all limits. The admission transition to
`dispatching` is the single launch marker. A refusal before it proves zero requests. After it, Factory
never launches the invocation again. Recovery observes and collects the same invocation through its
durable receipt or the local route's invocation identity. Deterministic local recovery may compute
only missing bytes in that same invocation's checkpoint, while preserving and verifying each
completed variant; it never starts a new provider dispatch. If exact observation is unavailable,
consumption stays unknown and replacement remains blocked.

A successful adapter response is intermediate. Factory validates every variant against its MIME,
profile, visibility, rights, count, and byte bounds, then fsyncs the exact bytes into private local
retention. It uploads those retained bytes through the existing immutable content-transfer substrate.
Only when every storage receipt is ready does Factory publish an immutable Asset Set and move the
producer to review. Mutable provider URLs are never storage authority. A restart resumes retained
bytes or existing transfer intents; it does not regenerate the output. Exact native usage is
recorded by declared unit, and unavailable values remain `null`. Failed cleanup or unknown usage
keeps the issue admission and capacity obligation occupied.

Review uses authenticated, request-ID commands:

- `factory asset-status OWNER/REPO#OBJECTIVE --asset-set-digest DIGEST`
- `factory asset-export OWNER/REPO#OBJECTIVE --asset-set-digest DIGEST --descriptor-digest DIGEST`
- `factory asset-approve OWNER/REPO#OBJECTIVE --request-id ID --asset-set-digest DIGEST --descriptor-digest DIGEST`
- `factory asset-reject OWNER/REPO#OBJECTIVE --request-id ID --asset-set-digest DIGEST --reason TEXT`
- `factory asset-revise OWNER/REPO#OBJECTIVE --request-id ID --asset-set-digest DIGEST --reason TEXT`

The equivalent MCP tools are `factory_asset_status`, `factory_asset_export`,
`factory_asset_approve`, `factory_asset_reject`, and `factory_asset_revise`. `asset-export`
recovers one exact variant from its immutable produced-content transfer. Factory reauthenticates
the ready event, reservation, Asset Set, storage manifest, descriptor, receipt, content digest, and
byte count, and requires the authenticated caller to be the activating run actor before writing a
read-only file under its private local review directory. The result
returns that verified local path and the complete descriptor and storage receipt. It does not
return inline bytes, follow a provider URL, or interpret the media format. The private path is
content-addressed; only the schema-validated basename is preserved so ordinary viewers can identify
the format, while the descriptor's logical materialization path never selects the destination.
Repeating the exact export after a restart verifies and returns the same local materialization.

Factory resolves run, producer attempt,
reservation, invocation, and base authority from the authenticated `AssetSetReady` event; callers do
not supply them. The same request ID and exact decision returns the original record. Reusing a
request ID with changed selection or text, or deciding the same Asset Set twice, fails closed.
Before publishing a decision, Factory claims a request-ID-scoped immutable journal that binds the
repository, Objective, run, Asset Set, and complete decision. Concurrent processes repair the same
Asset Set index and authenticated events from that journal; a changed request loses the Git CAS and
cannot reuse the request ID.
Approval requires one or more unique descriptor digests and accepts no reason. Rejection and
revision require bounded human text and accept no descriptor selection. `asset-status` reauthenticates
the immutable Asset Set, decision, and activation chain and reports their exact refs and commits;
publication-pending states identify a durable record whose authenticated event still needs repair.
Approval first persists an immutable decision and activation, then publishes their authenticated
events. Rejection is terminal review evidence. Revision binds the prior Asset Set and feedback and
publishes its canonical one-shot retry command as part of the same journaled transaction. The
ordinary maximum-attempt policy still gates the new admission; the user does not issue a second
retry command. It never mutates or reuses the prior invocation.

The registered deterministic rule `factory/local-private-reference-v1` may be named in
`compilerMediaEgress.deterministicReviewRuleIds`. It approves all verified private PNG variants from
the local raster route for internal references. Factory binds the rule capability digest in the same
canonical decision shape used by a human approval and resumes a partially published decision or
activation without reviewing or producing again. The rule does not grant public visibility or rights.

An activation carries each selected descriptor and full storage receipt. Before admitting a
dependent repository Work Item, Factory resolves every generated requirement to the exact projected
producer activation and records an activation bundle in `AttemptReserved`. The runtime Worker Packet
contains deduplicated `assetInputs` for byte transport and a separate `mediaUses` entry for every
consumer intent, purpose, direction, obligation, criterion set, producer, and activation. The same
descriptor can therefore serve several semantic uses without duplicating its bytes. Recovery rebuilds
that exact activated packet from the reservation and refuses a changed descriptor, receipt,
activation, producer, or consumer identity.

The local route publishes immutable produced descriptors as private with unknown rights and does not
advertise the `product-asset` purpose. Those descriptors cannot later acquire different visibility or
rights. A future product producer must advertise lawful output authority, and policy must authorize
that authority before dispatch; public delivery must not reinterpret this route's descriptors as
publishable.
