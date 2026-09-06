# Bounded large-file contract (#116–#118)

This is implemented code and a regression corpus, not evidence of a live provider run. Execute
the checks only after all concurrent implementation is integrated. Installed WSL2 qualification,
provider execution and comparative economics remain separate work; native Linux/macOS runs are
explicitly deferred by the user. No model-selection or invoice-finality claim follows from this code.

## Content and consumers

Legacy artifact-v1 inline patches retain their original digest formula and 5 MiB ceiling. New
collection binds `fileManifest` into the digest: exact base/result Git trees, changed relative path,
write/delete action, regular/executable mode, actual bytes, SHA-256, generated-path classification
and known media signature. PNG/JPEG/GIF/WebP/PDF/Wasm/ZIP/WAV/MP4 signatures are recognized;
`unknown` is valid. A signature is not semantic or full-format validation. Declared criterion-bound
validation and review remain necessary. Symlinks, gitlinks, traversal and special files fail closed.

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

Pending local data is private, no-follow, bounded to 16 descriptors and 512 MiB observed storage,
with fsynced files/directory, retained across restart and deleted only after ready publication.
Incomplete directories fail closed. Admission is serialized within a process; cross-process disk
accounting is a conservative observed guard, not an atomic filesystem quota. A full cache requires
recovering the identified pending transfers, not silently deleting their only bytes. GitHub ready
and intent refs retain repository audit data indefinitely. Failed uploads can leave unreferenced Git
objects before ref publication; GitHub provides no per-blob delete, and its own unreachable-object
retention/GC is not a Factory cleanup guarantee. No source-content secrets may be uploaded to make
cleanup easier. Operators may retire audit refs only through separately authorized repository policy.

Process chunk storage is separately capped at 512 MiB observed active allocations. Acquire
`retainArtifactContent(payload)` immediately for each owning pipeline/attempt; its idempotent async
release runs only after that owner's consumers drain. Per-chunk references protect shared data
held by another Objective. Root cleanup checks exact owned prefixes; dead process optimization
caches can be removed because pending data/ready refs are separate. Global release is permitted
only after all consumers drain, and refuses active leases. These are trusted same-user process
boundaries, not a hostile-worker isolation or disk-quota mechanism.

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
