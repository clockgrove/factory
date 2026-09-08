# Large-file support and limits

Factory handles large source files and artifacts within explicit size, integrity and provider
boundaries. This guide describes those limits; see
[verification status](https://github.com/clockgrove/factory/blob/main/docs/CONFORMANCE.md)
for the exact environments and scenarios demonstrated so far.

## Content and consumers

Legacy artifact-v1 inline patches retain their original digest formula and 5 MiB ceiling. New
collection binds `fileManifest` into the digest: exact base/result Git trees, changed relative path,
write/delete action, regular/executable mode, actual bytes, SHA-256, generated-path classification
and known media signature. PNG/JPEG/GIF/WebP/PDF/Wasm/ZIP/WAV/MP4 signatures are recognized;
`unknown` is valid. A signature is not semantic or full-format validation. Declared criterion-bound
validation and review remain necessary. Object-only sibling refresh additionally represents Git
symlinks as mode `120000`, media `unknown`, and the raw target blob's byte count/SHA-256; it never
creates or follows a filesystem link. Local source materialization, retry seeding and executable
validation still refuse symlinks. Gitlinks, traversal and special files remain unsupported.

`artifactFromPatchFile` applies the real patch to a private index and hashes the resulting Git blobs;
it does not trust producer-reported paths or media. Above 5 MiB, `payload` binds an ordered sequence
of at most 64 chunks, each at most 4 MiB, plus total bytes and whole-patch SHA-256. The small `patch`
field is then an identity marker, never applicable patch text. Limits: 5,000 changed files,
100,000,000 bytes per regular result blob, 256 MiB aggregate result bytes and 256 MiB patch bytes.
Binary Git patch expansion counts toward the patch ceiling. Exceeding a bound is actionable refusal,
not truncation. Runtime schemas additionally enforce sums, safe paths and exact marker binding;
the published JSON schema represents structural constraints, not those cross-field invariants.

Local CLI/SDK/App Server collection, Daytona host collection, clean application, publication,
sibling refresh and Supervisor Git-range reconstruction consume verified bytes through
`materializeArtifactPatch`/`artifactFromGitRange`. New review context supplies the manifest and an
independently validated checkout, not binary bytes in a prompt. Authenticated old receipt digests
may select the exact legacy inline representation; unauthenticated fallback is not allowed.

## Source and provider boundaries

Local workspaces use an owned, hook/filter-free exact Git-tree materialization. Daytona source is
tar-streamed from that tree into a bounded owned file, secret-scanned and SHA-256 bound before any
provider upload. The SDK receives a local path, not a giant Buffer. Its content-addressed remote
name and source manifest bind the archive; worker and validator verify bytes/hash before extraction
and the reconstructed Git index against the pinned base tree before model/validation commands.
Repositories whose attributes normalize archived bytes into a different Git tree fail this guard.
Attempt-start metadata records the archive digest and byte count. Source is provider-ephemeral and
is removed with its owned sandbox; artifact output below is durably retained in GitHub. No separate
Factory host/storage service is required. Archive overhead counts toward the 256 MiB ceiling.

Daytona result download checks remote file metadata then streams under a hard byte ceiling and
deadline into an owned host file; trusted host reconstruction checks actual paths/blobs before
upload/publication. Other metadata/log files retain their smaller bounds. Vercel Labs retains its
64 MiB source/5 MiB result path and refuses externalized validation; select local or Daytona for
oversized work. Remote LFS hydration is refused before paid creation. Managed-provider output
interfaces that return only inline patches do not acquire an invented large-object API.

## Durable output lifecycle and recovery

`persistArtifactTransfer` takes exact repository/objective/work-item/attempt/run/epoch/policy/base
identity, allowed paths and a fresh `assertCurrent` fence. It validates every byte and scans secrets
before any external write, including the descriptor. It first retains private local descriptor/chunk
bytes, then publishes immutable GitHub `/intent` and `/ready` refs under the hashed exact identity.
Ready is a child of intent, contains reachable content blobs, and binds the same descriptor. Every
store mutation uses the caller's paced GitHub store and fresh fence. No model call regenerates data.

Supervisor must persist before success/cleanup and call `resumeArtifactTransfer` before replacement
execution. Resume uses exact retained local data or exact remote blob OIDs, rechecks fresh packet,
path and attempt authority, and completes only the original publication. Ready recovery checks
commit/tree/blob/descriptor identity, every chunk and whole-patch digest. Missing partial data is a
typed incomplete transfer, never permission to rerun a worker. Local bytes are not runtime status or
proof of terminal token usage; authenticated attempt/host/resource evidence is still required.
Existing exact scalar-only token receipts remain usable without inventing a breakdown. Conflicting
success, token or native-usage evidence fails closed. Recovery does not grant a new implementation
attempt or replace a missing independent-validation allowance.

Pending local data is private, no-follow, bounded to 16 descriptors and 512 MiB observed storage,
with fsynced files/directory, retained across restart and deleted only after ready publication.
Incomplete directories fail closed. Admission is serialized within a process; cross-process disk
accounting is a conservative observed guard, not an atomic filesystem quota. A full cache requires
recovering the identified pending transfers, not silently deleting their only bytes. GitHub ready
and intent refs retain repository audit data indefinitely. Failed uploads can leave unreferenced Git
objects before ref publication; GitHub provides no per-blob delete, and its own unreachable-object
retention/GC is not a Factory cleanup guarantee. No source-content secrets may be uploaded to make
cleanup easier. Operators may retire audit refs only through separately authorized repository policy.

Before bulk byte admission, each pending directory receives a fsynced, secret-scanned identity and
artifact-digest marker of at most 2 KiB (at most 16 directories; this small metadata reserve precedes
the observed bulk-byte guard). Marker-only directories are incomplete, not absent. Even if creating
the directory or its first durable write fails, stale recovery does not infer retry permission from
missing content. After exact artifact/session recovery and resource reconciliation, an execution
reservation or dispatch without explicit terminal failure/cancellation/defer or completed validation
blocks automatic replacement. Explicit known failures, including recorded no-dispatch rejection,
retain their existing retry rules. An unknown post-dispatch observation is not journaled as a known
failure. If every durable copy failed, preserved source may require explicit recovery direction;
this guard prevents duplicate execution but cannot promise recovery of bytes that were never saved.

Process chunk storage is separately capped at 512 MiB observed active allocations. Acquire
`retainArtifactContent(payload)` immediately for each owning pipeline/attempt; its idempotent async
release runs only after that owner's consumers drain. Per-chunk references protect shared data
held by another Objective. Root cleanup checks exact owned prefixes; dead process optimization
caches can be removed because pending data/ready refs are separate. Global release is permitted
only after all consumers drain, and refuses active leases. These are trusted same-user process
boundaries, not a hostile-worker isolation or disk-quota mechanism.
Capture and restoration join the current operation's lease before asynchronous handoff; active
allocations are excluded from empty-root cleanup. On a transfer failure the still-owned workspace
can be removed only after verifying a complete exact local recovery copy or ready GitHub artifact.
If that proof is unavailable, the workspace remains intact.

Candidate/rebase payloads are rebuilt from pinned source/target Git SHAs and checked against the
authenticated existing validation digest before reuse. Their planned Git trees/commits remain
durable; local payload chunks are not a second source of truth. Reconstruction never invokes a
model. Runtime candidate consumers hold the same per-operation content leases as worker output.

## Existing LFS repositories

Preflight detects canonical and legacy LFS pointers, requires `git-lfs`, and hashes existing standard
local objects before a paid management/worker call. Bounds are 256 assets, 100 MiB per asset and
256 MiB total. Pointer extensions are refused. Provision authorized content into the standard local
cache beforehand. No fetch, smudge/clean hook, config edit, attribute rewrite or migration occurs.

Hydration preserves the exact pointer index. Unchanged hydrated assets are omitted from collection
only after hashing bytes and checking size. Changed pinned LFS paths and new pointer outputs are
refused without a supported authenticated upload lifecycle. Clean validation uses `git apply --index`
and `write-tree`, not `git add -A`; publication uses that exact index tree. Thus unrelated hydrated
assets cannot become committed binary replacements. Git's working-tree dirty view still reports
hydrated LFS assets without a clean filter; validations relying on a clean `git diff` must account for
that documented limitation. Remote fetch/upload is a provider-specific missing capability, not a
reason to remove generic non-LFS large-file support.

## Primary API contracts and regression entry points

GitHub [blobs](https://docs.github.com/en/rest/git/blobs) document base64 content and the 100 MB blob
API limit; [trees](https://docs.github.com/en/rest/git/trees) bind paths/modes/blob OIDs. Daytona's
[filesystem SDK](https://www.daytona.io/docs/typescript-sdk/file-system/) documents streaming local
path uploads. The [LFS pointer specification](https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md)
defines pointer identities and format. No undocumented provider object-store calls are assumed.

`test/large-file-content.test.ts` exercises real oversized Git patches/source archives, media and
mode identity, LFS refusal, corrupt metadata and shared-cache leases. `test/artifact-transfers.test.ts`
exercises immutable refs, per-write fencing, pre-intent/post-intent interruption and exact resume,
remote corruption and scope rejection with an in-memory Git-object contract. Those tests establish
local contracts only; they do not substitute for installed/provider execution evidence.

## Installed local qualification

`scripts/verify-local-large-files.mjs` reuses the installed-client and exact-controller boundaries
of the local checkpoint qualifier. No opt-in means no actions. This is contributor qualification,
not a user-facing runtime API or a claim that these scenarios have passed.

The current runner requires a freshly generated version-2 fixture. Its committed test imports
Vitest and every generated Objective names the repository-observed `npm test` validation command;
older version-1 fixtures remain bound to their original evidence and are not reusable with this
runner.

Prepare each case in a fresh disposable private repository/namespace. The offline
`createLargeFileFixture` export in `scripts/qualification-large-files.mjs` accepts an owned `parent`
directory and `namespace`. Its standalone mode supports fixture unit tests, but an installed
version-2 scenario also requires a local `sourceRepository` and its exact current default-branch
`baseSha`. The runner verifies that source parent and its committed Vitest npm recipe before creating
an Objective. The generator creates a private `root/fixture.json`, a fresh `repository`, an exact
child baseline commit, and two verified synthetic objects in that repository's standard LFS cache.
It does not fetch, publish, install LFS or invoke a model. For example, from the committed Factory
source:

```bash
node --input-type=module -e '
  import { createLargeFileFixture } from "./scripts/qualification-large-files.mjs";
  const [parent, namespace, sourceRepository, baseSha] = process.argv.slice(1);
  const fixture = createLargeFileFixture({ parent, namespace, sourceRepository, baseSha });
  console.log(JSON.stringify({ descriptor: `${fixture.root}/fixture.json`,
    checkout: fixture.repository, baseSha: fixture.baseSha }, null, 2));
' /absolute/private/preparation large-file-example /absolute/disposable/source EXACT_BASE_SHA
```

Review and separately authorize publishing that exact baseline to the disposable target. Use the
prepared repository as the execution checkout, with its matching GitHub origin and installed
controller; this keeps the synthetic cache local without an implicit copy/fetch. The baseline must
contain only the two qualified LFS pointers, no symlinks/gitlinks, and no existing generated outputs.
The runner verifies raw baseline bytes/tree, exact default-branch identity and the cache preconditions
before any scenario action. It requires an inactive matching controller, no other runnable Objective
and no open PR. Never repurpose an active development checkout or delete another run's evidence.

Set these explicit variables, then run `node scripts/verify-local-large-files.mjs`:

| Variable | Required value |
| --- | --- |
| `FACTORY_LOCAL_LARGE_FILES` | `1` |
| `FACTORY_LARGE_FILE_CASE` | `transfer-restart`, `lfs-missing-tool`, `lfs-missing-object`, `scope`, `secret` or `symlink` |
| `FACTORY_LARGE_FILE_PHASE` | `preflight` first; `exercise` only with accepted scenario authority |
| `FACTORY_LARGE_FILE_REPOSITORY` / `FACTORY_LARGE_FILE_CHECKOUT` | Exact private `owner/repo` and canonical Linux-home checkout |
| `FACTORY_LARGE_FILE_CONTROLLER_UNIT` | Exact installed controller for that repository/checkout |
| `FACTORY_LARGE_FILE_NAMESPACE` | Fresh fixture namespace, unchanged from preparation |
| `FACTORY_LARGE_FILE_FIXTURE` / `FACTORY_LARGE_FILE_FIXTURE_SHA256` | Absolute private descriptor path and SHA-256 of its exact bytes |
| `FACTORY_LARGE_FILE_EVIDENCE` | New, nonexistent evidence file in an owned mode-0700 directory |
| `FACTORY_LARGE_FILE_MAX_MODEL_TOKENS` | Separately accepted bounded scenario allowance; no implicit default |
| `FACTORY_LARGE_FILE_ACK` | Exact exercise acknowledgement below; unnecessary for preflight |

Acknowledgements are `owner/repo:controller-unit:case:actions`, with these exact action suffixes:

- `transfer-restart`: `start,create,arm-transfer-intent,activate,pause,restart,resume,stop`
- Either `lfs-` case: `create,compile-refusal`
- `scope`, `secret`, `symlink`: `start,create,activate,stop`

Use the normal Linux-home plugin/authentication, with `GH_TOKEN`, `GITHUB_TOKEN`, `GH_HOST`,
`GH_CONFIG_DIR` and `XDG_CONFIG_HOME` unset. Source and installed bundle identities must match;
build/install only at the coordinated candidate boundary. Preflight and exercise need different
evidence files. A successful preflight proves prerequisites, not model execution or recovery.

The positive case runs three real serial App Server workers: a deterministic 6 MiB PCM WAV,
metadata plus executable, then a verification join. Only the first oversized result is held, after
durable transfer intent and retained bytes but before chunk/ready upload. The private one-shot arm
binds activation, policy, base and exact controller incarnation, expires within ten minutes, and
latches the original attempt/session/usage and artifact. Absent an arm, runtime behavior is unchanged.
Resume does not rearm or grant a replacement worker. An expired/uncertain hold is incomplete—not
permission to upload or rerun. The runner independently verifies intent→ready continuation, actual
reachable chunk bytes, original session/accounting, exact owned resource absence, all merged patch
trees, binary manifests, unchanged Git LFS pointers and final behavior in a credential-free,
network-isolated read-only fixture. Conservative native accounting remains labelled as such.

Negative cases use independent fresh fixtures. Missing-tool preparation uses a controlled process
PATH without `git-lfs`; missing-object preparation leaves a named synthetic cache object absent in
that new fixture only. Do not uninstall host tools or remove production content. These cases invoke
explicit compilation without starting the controller and require the pre-model LFS correction.
Other cases use a real worker to produce the committed scope, synthetic-secret or symlink output.
Scope/secret cases require collection refusal; symlink handling may retain raw Git objects but must
refuse filesystem materialization before validation commands or publication. Ref absence does not
prove zero unreferenced uploads, and a refusal alone does not prove zero model usage.

Failure preserves private evidence and stops automatic progression. There is no automatic retry,
new allowance, fixture publication, controller cleanup or retirement of audit refs. Inspect exact
retained ownership and use the authorized recovery path before deciding the next action.
