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
