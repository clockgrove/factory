# Application qualification

Application qualification exercises Factory through the installed plugin on a real application,
including behavior that small disposable fixtures cannot establish. A bounded pilot is the first
slice of this coverage; it does not replace the complete application qualification requirement.
See [release qualification](CONFORMANCE.md) for the publication gates and
[the design](DESIGN.md) for the product contract.

## Cross-cutting verification

### Deterministic tests

- schema compatibility, canonical digests, and strict cross-field validation;
- graph acyclicity, scope intersections, exclusive resources, and stack partitioning;
- priority, critical path, work-conserving admission, and multi-Objective ordering;
- CPU/memory sampling, capacity generations, cooldown, and reservation recovery;
- every budget, burst, trust, capability, and authority boundary;
- MCP tool annotations, idempotency, and positive/negative selection prompts;
- service-definition creation and safe removal;
- App Server lifecycle normalization and malformed output;
- stack publication, rebase invalidation, asynchronous merge, and fallback;
- status/explain/replay equivalence.

### Fault injection

Interrupt immediately before and after each GitHub write, provider launch, local thread start,
artifact collection, validation, push, PR creation, stack link, rebase, and merge request. On restart,
Factory must either continue the same fact or reconcile it before replacement. It may not duplicate
paid work, publish an unvalidated head, or spend the same reservation twice.

### Live conformance

Use disposable GitHub repositories and explicitly approved provider budgets to verify behavior that
mocks cannot establish: custom-ref compare-and-swap, sub-issue order, stack APIs, branch rules, merge
queues, rate limiting, provider TTL and cleanup, Codex thread resume, and installable plugin/service
lifecycle.

### Cost regression

For each golden Objective, retain private diagnostic artifacts for the graph, prompts, context
manifests, admission trace, attempts, usage, duration, and accepted commits outside version control.
Bind any sanitized release summary to the exact candidate and artifact. Compare compiler and scheduler versions on:

- validated Work Items per reported model-token unit;
- accepted-attempt usage versus discarded-attempt usage;
- duplicated context across workers;
- local utilization without host-pressure violations;
- serial critical path versus observed completion time;
- paid minutes and estimated minutes saved;
- retries caused by scope, context, merge, or validation errors;
- human interventions and whether each was policy-required.

These are diagnostic comparisons, not a single gameable score.

## Rich-media and simulation repositories

These requirements apply the general Factory contracts to repositories that contain large media,
generated content, deterministic simulations, visual behavior, or specialized authoring tools. It
does not change Factory's general-purpose audience, require an engine-specific runtime, or add a
game-specific product scope.

Large-file transfer, LFS support, manifests and provider-specific limits are described in
[the large-file contract](LARGE-FILES.md). Implementation support does not by itself establish
installed or paid-provider qualification.

### Large and binary artifact requirements

- Classify a path from repository evidence as text, generated, large/binary, or otherwise
  non-mergeable.
- Represent a binary artifact by path, byte size, media type when known, executable mode, and content
  digest. Never embed the content in a GitHub comment or model prompt.
- Enforce Work Packet path and size ceilings before accepting or uploading it.
- Serialize writers to the same non-mergeable path. Distinct binary paths may still run concurrently
  when their manifests and build outputs do not collide.
- Detect Git LFS pointers and required LFS tooling when a repository already uses them. Factory does
  not enable LFS, rewrite attributes, or migrate files automatically.
- Distinguish source assets from derived exports. Rebuild derived output through the repository's
  declared command when possible instead of asking a model to manipulate opaque bytes.
- Store oversized worker transfer artifacts in the selected backend's content-addressed artifact
  channel, while GitHub retains the digest and lifecycle receipt.

### Generated outputs

- The source and generated contracts, schemas, atlases, manifests, snapshots, or golden fixtures
  belong to one Work Item unless the generator output is an explicitly versioned dependency.
- Two parallel Work Items may not own the same generated tree, lockfile, registry, or aggregate
  manifest.
- Validation reruns the generator and fails on unexplained drift.
- Generated size does not count as useful model-authored progress when measuring worker yield.

### Deterministic and simulation-heavy code

- Work Packets pin seed, clock/time fixture, schema/protocol version, scenario identity, and expected
  state/event hash when the repository exposes them.
- Exact deterministic tests run before model-assisted semantic review.
- Nondeterministic services use recorded or scripted fixtures for merge gates; live-provider checks
  remain separately labeled qualification evidence.
- A worker may update an expected golden result only when the Work Item explicitly owns the semantic
  change and validation explains the before/after difference.

### Visual and experiential validation

- A visual validation plan pins scenario, data/seed, viewport or output dimensions, environment,
  tool version, and capture command.
- Factory records capture digests and bounded diffs with the exact validated commit.
- Mechanical comparison may accept unchanged or threshold-bounded output. A deliberate change in
  visual intent remains a legitimate human review boundary unless the Objective pre-authorized an
  exact replacement fixture.
- Screenshots, rendered frames, audio summaries, and other evidence are attachments or artifact
  references, not a reason to add a Factory-specific UI.

### Exclusive tools and constrained resources

- Declare an editor, emulator, GPU, hardware device, singleton license, port, local service, or shared
  cache as an exclusive resource only when repository/toolchain evidence requires it.
- Resource claims participate in ordinary admission and are released through the same fenced
  attempt lifecycle.
- Factory never assumes that a game or media repository requires a GPU or editor. Headless commands
  remain preferred when the repository provides them.

<a id="first-party-dogfood-contract"></a>

### Application pilot

The [application pilot](https://github.com/clockgrove/factory/issues/86) exercises portable Factory
behavior without defining Factory implementation details or reproducing an adopter's architecture. Project-specific implementation facts, paths, and source documents remain
in the adopter repository and enter Factory only through ordinary repository grounding.

The portable behaviors below inform the full application qualification. A bounded pilot
is its first slice, not a substitute for the full scenario coverage. Record which actual application
Objective and accepted result exercises each applicable behavior; if the repository cannot yet
supply a scenario, keep that gap explicit rather than marking it passed. No engine-specific Factory
code or new application feature is implied solely to manufacture evidence:

- a repository may expose deterministic behavior whose Work Packets must pin seeds, fixtures,
  versions, scenarios, and expected hashes;
- versioned content may combine schemas, migrations, manifests, provenance, and expected output
  without making Factory the authority for that content;
- source, reviewed, and generated assets may require different ownership and validation rules;
- large or binary artifacts may require content-addressed transfer while GitHub retains only bounded
  metadata, digests, and lifecycle receipts;
- visual or experiential changes may require reproducible captures and an explicit human review
  boundary;
- generated contracts and golden fixtures may require source-coupled ownership and drift checks;
- browser, realtime, accessibility, replay, provider, and staging checks may require distinct
  commands and evidence rather than one vague “tests pass” criterion; and
- Factory must remain external development tooling: an adopter stays buildable and operable without
  Factory installed, and Factory state never becomes product/runtime authority.

### Required application scenarios

Exercise Factory through the installed plugin, rather than a development worktree MCP
configuration. Use application Objectives that cover these scenarios as the repository makes
them available:

- a dependency-heavy platform feature;
- parallel code and tests;
- a large/binary artifact or generated-file conflict;
- an expensive build or validation resource;
- a local-to-cloud burst decision;
- a lower-layer change in a live PR stack;
- a controller or worker crash and recovery;
- a genuine human product decision.

The gate is scenario coverage, not a fixed number of Objectives or Work Items. Keep unavailable
scenarios explicit. Record both successful and uneconomic decompositions, then adjust compiler
and scheduler rules through versioned tests rather than hidden heuristics. Existing provider,
spending, and fixture-retirement requirements apply to these exercises.

### Promotion rule

Application testing may reveal reusable Factory requirements, but no adopter receives hard-coded branches in
Factory. Promote a project-specific observation into the core only when:

1. the generic repository-facts, Work Packet, artifact, or validation contract cannot express it;
2. an actual application Work Item demonstrates the failure with bounded evidence;
3. the proposed extension has a provider/framework-neutral contract;
4. a second, unrelated fixture proves that the abstraction is reusable;
5. the extension passes ordinary compatibility, recovery, cost, and security gates.

Otherwise, keep the behavior in a repository-supplied profile, skill, or validation command rather
than expanding Factory itself.
