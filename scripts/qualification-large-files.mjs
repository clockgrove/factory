/** Bounded fixture construction and independent content proofs, not an installed-runtime verdict.
 * No source runtime imports, remote Git operations, model calls, or implicit LFS installation.
 * The installed driver owns activation, provenance, publication and transfer/restart evidence.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const LARGE_FILE_RECIPE_VERSION = "factory-large-files-fixture-v1";
export const LARGE_FILE_AUDIO_BYTES = 6 * 1024 * 1024 + 44;
const MAX_PATCH_BYTES = 12 * 1024 * 1024;
const INLINE_BYTES = 5 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gitOid = (type, bytes) =>
  createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");

function assertNamespace(namespace) {
  assert.match(namespace, /^[a-z](?:[a-z0-9-]{6,46}[a-z0-9])$/);
  return namespace;
}
function relativePath(path) {
  assert.ok(typeof path === "string" && path.length > 0 && path.length <= 500);
  assert.ok(!isAbsolute(path) && !path.includes("\\"));
  assert.ok([...path].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127));
  assert.ok(
    path
      .split("/")
      .every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git"),
  );
  return path;
}
export function largeFilePaths(namespace) {
  const prefix = `factory-large-files/${assertNamespace(namespace)}`;
  return {
    prefix,
    attributes: `${prefix}/.gitattributes`,
    recipe: `${prefix}/large-files-recipe.mjs`,
    test: `${prefix}/large-files.test.mjs`,
    canonical: `${prefix}/lfs/canonical.bin`,
    legacy: `${prefix}/lfs/legacy.bin`,
    payload: `${prefix}/generated/qualification-audio.wav`,
    executable: `${prefix}/tools/qualification-check.mjs`,
    metadata: `${prefix}/generated/qualification-metadata.json`,
    result: `${prefix}/generated/qualification-result.json`,
  };
}

// Valid mono 8-bit PCM WAV. Full-period xorshift32 words keep the Git binary patch genuinely
// large; a repeated-byte blob would compress below the transfer threshold. No random credentials.
function audioBytes() {
  const bytes = Buffer.alloc(6 * 1024 * 1024 + 44);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(8000, 28);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  let state = 0x6d2b79f5;
  for (let offset = 44; offset < bytes.length; offset += 4) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes.writeUInt32LE(state >>> 0, offset);
  }
  return bytes;
}
function outputFiles(namespace) {
  const paths = largeFilePaths(namespace);
  const audio = audioBytes();
  const metadata = Buffer.from(
    `${JSON.stringify({ recipe: "factory-large-files-fixture-v1", bytes: audio.length, sha256: hash(audio), format: "PCM-u8-mono-8000Hz" }, null, 2)}\n`,
  );
  const executable = Buffer.from(
    `#!/usr/bin/env node\nimport { verify } from "../large-files-recipe.mjs";\nverify("metadata");\n`,
  );
  const result = Buffer.from(
    `${JSON.stringify({ recipe: "factory-large-files-fixture-v1", verified: true, payloadSha256: hash(audio), metadataSha256: hash(metadata), executableSha256: hash(executable) }, null, 2)}\n`,
  );
  return [
    {
      path: paths.payload,
      phase: "payload",
      bytes: audio,
      mode: "100644",
      mediaType: "audio/wav",
      generated: true,
    },
    {
      path: paths.executable,
      phase: "metadata",
      bytes: executable,
      mode: "100755",
      mediaType: "unknown",
      generated: false,
    },
    {
      path: paths.metadata,
      phase: "metadata",
      bytes: metadata,
      mode: "100644",
      mediaType: "unknown",
      generated: true,
    },
    {
      path: paths.result,
      phase: "join",
      bytes: result,
      mode: "100644",
      mediaType: "unknown",
      generated: true,
    },
  ];
}
function phaseFiles(namespace, phase) {
  assert.ok(["payload", "metadata", "join"].includes(phase), "unknown fixture phase");
  return outputFiles(namespace).filter((file) => file.phase === phase);
}

function safeDirectory(root, relative) {
  let current = root;
  for (const part of relative.split("/").filter(Boolean)) {
    current = join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const info = fs.lstatSync(current);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), "fixture parent is not a directory");
  }
  return current;
}
function exclusiveFile(root, path, bytes, mode = "100644") {
  relativePath(path);
  safeDirectory(root, dirname(path) === "." ? "" : dirname(path));
  const fd = fs.openSync(
    join(root, path),
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    mode === "100755" ? 0o755 : 0o644,
  );
  try {
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, mode === "100755" ? 0o755 : 0o644);
  } finally {
    fs.closeSync(fd);
  }
}
function regularBytes(root, path, maximum) {
  relativePath(path);
  let current = root;
  const parts = path.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = fs.lstatSync(current);
    assert.ok(
      !info.isSymbolicLink() && (index === parts.length - 1 ? info.isFile() : info.isDirectory()),
      "fixture content is not regular",
    );
  }
  const fd = fs.openSync(
    current,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = fs.fstatSync(fd);
    assert.ok(before.isFile() && before.size <= maximum, "fixture content exceeds bound");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      assert.ok(count > 0, "fixture content truncated");
      offset += count;
    }
    assert.equal(fs.readSync(fd, Buffer.alloc(1), 0, 1, offset), 0, "fixture content grew");
    const after = fs.fstatSync(fd);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    return { bytes, mode: before.mode & 0o111 ? "100755" : "100644" };
  } finally {
    fs.closeSync(fd);
  }
}

function recipeOutput(root, namespace, scenario, phase) {
  const paths = largeFilePaths(namespace);
  if (scenario === "accepted") {
    for (const file of phaseFiles(namespace, phase))
      exclusiveFile(root, file.path, file.bytes, file.mode);
  } else if (scenario === "scope") {
    exclusiveFile(
      root,
      `${paths.prefix}/outside-scope.txt`,
      Buffer.from("Synthetic out-of-scope refusal fixture.\n"),
    );
  } else if (scenario === "secret") {
    // Synthetic, deliberately invalid credential canary, assembled only when this negative runs.
    // Use the allowed payload path and cross a 64 KiB boundary to exercise content scanning.
    const bytes = audioBytes();
    bytes.write(`${"gh" + "p_"}${"Q".repeat(40)}`, 65530, "ascii");
    exclusiveFile(root, paths.payload, bytes);
  } else if (scenario === "symlink") {
    safeDirectory(root, dirname(paths.payload));
    fs.symlinkSync("../lfs/canonical.bin", join(root, paths.payload));
  } else {
    assert.fail("unknown output scenario");
  }
}

export function renderLargeFileRecipe(template, namespace) {
  assertNamespace(namespace);
  assert.ok(
    typeof template === "string" && Buffer.byteLength(template) <= 32 * 1024,
    "standalone recipe template exceeds its bound",
  );
  const marker = '"__FACTORY_LARGE_FILE_NAMESPACE__"';
  const first = template.indexOf(marker);
  assert.ok(
    first >= 0 && first === template.lastIndexOf(marker),
    "standalone recipe template must contain exactly one namespace marker",
  );
  const rendered = template.replace(marker, JSON.stringify(namespace));
  assert.ok(Buffer.byteLength(rendered) <= 32 * 1024, "standalone recipe exceeds its bound");
  return rendered;
}
function recipeSource(namespace) {
  // Copy committed raw source, never function.toString(): test/build transforms may rewrite
  // imported bindings into names that cannot exist in a standalone worker process.
  const directory = dirname(fileURLToPath(import.meta.url));
  const template = regularBytes(directory, "qualification-large-files-recipe.mjs", 32 * 1024);
  return renderLargeFileRecipe(
    new TextDecoder("utf-8", { fatal: true }).decode(template.bytes),
    namespace,
  );
}
function baselineFiles(namespace) {
  const paths = largeFilePaths(namespace);
  const lfs = [
    {
      path: paths.canonical,
      version: "https://git-lfs.github.com/spec/v1",
      content: Buffer.from("Factory qualification canonical LFS object; public synthetic bytes.\n"),
    },
    {
      path: paths.legacy,
      version: "https://hawser.github.com/spec/v1",
      content: Buffer.from("Factory qualification legacy LFS object; public synthetic bytes.\n"),
    },
  ];
  for (const asset of lfs) {
    asset.oid = hash(asset.content);
    asset.pointer = Buffer.from(
      `version ${asset.version}\noid sha256:${asset.oid}\nsize ${asset.content.length}\n`,
    );
  }
  return {
    lfs,
    files: [
      {
        path: paths.attributes,
        bytes: Buffer.from("lfs/*.bin filter=lfs diff=lfs merge=lfs -text\n"),
      },
      { path: paths.recipe, bytes: Buffer.from(recipeSource(namespace)) },
      {
        path: paths.test,
        bytes: Buffer.from(
          'import {test} from "node:test";\nimport {verify} from "./large-files-recipe.mjs";\ntest("exact large-file bytes and modes",()=>verify());\n',
        ),
      },
      ...lfs.map((asset) => ({ path: asset.path, bytes: asset.pointer })),
    ],
  };
}

function git(repository, args, input, maximum = 1024 * 1024, deadline = Date.now() + 120_000) {
  const remaining = deadline - Date.now();
  assert.ok(remaining > 0, "fixture Git deadline exceeded");
  const result = spawnSync(
    "/usr/bin/git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      "-c",
      "protocol.allow=never",
      "-c",
      "core.attributesFile=/dev/null",
      ...args,
    ],
    {
      cwd: repository,
      input,
      maxBuffer: maximum,
      timeout: Math.min(remaining, 30_000),
      env: {
        PATH: "/usr/bin:/bin",
        HOME: repository,
        LANG: "C",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_LFS_SKIP_SMUDGE: "1",
        GIT_AUTHOR_NAME: "Factory qualification",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Factory qualification",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      },
    },
  );
  assert.ok(!result.error && result.status === 0, "bounded fixture Git operation failed");
  return result.stdout;
}
const gitText = (...args) =>
  git(...args)
    .toString("utf8")
    .trim();
function listing(repository, treeish, prefix, deadline) {
  assert.match(treeish, /^[a-f0-9]{40}$/);
  const entries = git(
    repository,
    ["ls-tree", "-r", "-t", "-l", "-z", treeish, ...(prefix ? ["--", prefix] : [])],
    undefined,
    4 * 1024 * 1024,
    deadline,
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  assert.ok(entries.length <= 10_000, "fixture source entry count exceeds bound");
  return entries.map((entry) => {
    const match = /^(100644|100755|040000) (blob|tree) ([a-f0-9]{40})\s+(\d+|-)\t(.+)$/.exec(entry);
    assert.ok(match, "fixture source has unsupported mode or object");
    relativePath(match[5]);
    return {
      mode: match[1],
      type: match[2],
      oid: match[3],
      bytes: match[4] === "-" ? null : Number(match[4]),
      path: match[5],
    };
  });
}
function importBase(source, destination, baseSha, deadline) {
  assert.equal(fs.realpathSync(source), resolve(source), "source path must be canonical");
  const commit = git(source, ["cat-file", "commit", baseSha], undefined, 1024 * 1024, deadline);
  assert.equal(gitOid("commit", commit), baseSha);
  const tree = /^tree ([a-f0-9]{40})\n/.exec(commit.toString("utf8"))?.[1];
  assert.ok(tree, "source commit lacks tree");
  const entries = listing(source, baseSha, undefined, deadline);
  const files = entries.filter((entry) => entry.type === "blob");
  assert.ok(files.length <= 5000 && files.every((file) => file.bytes <= 100 * 1024 * 1024));
  assert.ok(files.reduce((sum, file) => sum + file.bytes, 0) <= 256 * 1024 * 1024);
  const objects = [{ type: "tree", oid: tree, bytes: null }, ...entries];
  const copied = new Set();
  for (const object of objects) {
    if (copied.has(object.oid)) continue;
    const bytes = git(
      source,
      ["cat-file", object.type, object.oid],
      undefined,
      (object.bytes ?? 4 * 1024 * 1024) + 1024,
      deadline,
    );
    assert.equal(gitOid(object.type, bytes), object.oid);
    assert.equal(
      gitText(
        destination,
        ["hash-object", "-w", "--stdin", "-t", object.type],
        bytes,
        1024,
        deadline,
      ),
      object.oid,
    );
    copied.add(object.oid);
  }
  for (const file of files) {
    const bytes = git(
      destination,
      ["cat-file", "blob", file.oid],
      undefined,
      file.bytes + 1024,
      deadline,
    );
    exclusiveFile(destination, file.path, bytes, file.mode);
  }
  assert.equal(
    gitText(destination, ["hash-object", "-w", "--stdin", "-t", "commit"], commit, 1024, deadline),
    baseSha,
  );
  git(destination, ["read-tree", baseSha], undefined, 1024, deadline);
  return tree;
}
function describeFile(file) {
  return {
    path: file.path,
    mode: file.mode ?? "100644",
    bytes: file.bytes.length,
    digest: hash(file.bytes),
  };
}

export function createLargeFileFixture({ parent, namespace, sourceRepository, baseSha }) {
  assertNamespace(namespace);
  assert.equal(
    sourceRepository === undefined,
    baseSha === undefined,
    "source repository/base must be paired",
  );
  assert.equal(fs.realpathSync(parent), resolve(parent), "fixture parent must be canonical");
  assert.ok(fs.lstatSync(parent).isDirectory());
  if (baseSha !== undefined) assert.match(baseSha, /^[a-f0-9]{40}$/);
  const id = randomUUID();
  const root = fs.mkdtempSync(join(parent, `factory-large-files-${id}-`));
  fs.chmodSync(root, 0o700);
  const repository = join(root, "repository");
  fs.mkdirSync(repository, { mode: 0o700 });
  const deadline = Date.now() + 120_000;
  git(
    repository,
    ["init", "--quiet", "--template=", "--object-format=sha1"],
    undefined,
    1024,
    deadline,
  );
  const sourceTreeSha = sourceRepository
    ? importBase(sourceRepository, repository, baseSha, deadline)
    : undefined;
  const baseline = baselineFiles(namespace);
  for (const file of baseline.files) {
    exclusiveFile(repository, file.path, file.bytes);
    const oid = gitText(repository, ["hash-object", "-w", "--stdin"], file.bytes, 1024, deadline);
    git(
      repository,
      ["update-index", "--add", "--cacheinfo", "100644", oid, file.path],
      undefined,
      1024,
      deadline,
    );
  }
  const baseTreeSha = gitText(repository, ["write-tree"], undefined, 1024, deadline);
  const fixtureBase = gitText(
    repository,
    [
      "commit-tree",
      baseTreeSha,
      ...(baseSha ? ["-p", baseSha] : []),
      "-m",
      `Large-file qualification baseline ${namespace}`,
    ],
    undefined,
    1024,
    deadline,
  );
  git(repository, ["update-ref", "refs/heads/main", fixtureBase], undefined, 1024, deadline);
  git(repository, ["symbolic-ref", "HEAD", "refs/heads/main"], undefined, 1024, deadline);
  const lfs = baseline.lfs.map((asset) => {
    const object = `.git/lfs/objects/${asset.oid.slice(0, 2)}/${asset.oid.slice(2, 4)}/${asset.oid}`;
    // Only this new repository's standard cache is written; never fetch or invoke git-lfs.
    fs.mkdirSync(dirname(join(repository, object)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(repository, object), asset.content, { flag: "wx", mode: 0o600 });
    assert.equal(hash(fs.readFileSync(join(repository, object))), asset.oid);
    return {
      path: asset.path,
      oid: asset.oid,
      size: asset.content.length,
      pointerDigest: hash(asset.pointer),
      pointerBlobOid: gitOid("blob", asset.pointer),
      mode: "100644",
      objectPath: object,
    };
  });
  const descriptor = {
    version: LARGE_FILE_RECIPE_VERSION,
    id,
    namespace,
    root,
    repository,
    baseSha: fixtureBase,
    baseTreeSha,
    ...(baseSha ? { sourceBaseSha: baseSha, sourceTreeSha } : {}),
    paths: largeFilePaths(namespace),
    recipePath: largeFilePaths(namespace).recipe,
    baseline: baseline.files.map(describeFile),
    lfs,
    expected: outputFiles(namespace).map((file) => ({
      ...describeFile(file),
      phase: file.phase,
      mediaType: file.mediaType,
      generated: file.generated,
    })),
  };
  fs.writeFileSync(join(root, "fixture.json"), `${JSON.stringify(descriptor, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return descriptor;
}

function ownedFixture(fixture, checkout = fixture.repository) {
  assert.equal(fixture.version, LARGE_FILE_RECIPE_VERSION);
  assert.match(fixture.id, /^[a-f0-9-]{36}$/);
  assert.ok(basename(fixture.root).startsWith(`factory-large-files-${fixture.id}-`));
  assert.equal(fs.realpathSync(fixture.root), fixture.root);
  const info = fs.lstatSync(fixture.root);
  assert.ok(info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o077) === 0);
  const saved = JSON.parse(
    regularBytes(fixture.root, "fixture.json", 64 * 1024).bytes.toString("utf8"),
  );
  assert.deepEqual(saved, fixture, "fixture descriptor differs from its owned preparation");
  assert.equal(fs.realpathSync(checkout), resolve(checkout));
  assert.ok(
    checkout.startsWith(`${fixture.root}${sep}`),
    "fixture output cannot mutate another checkout",
  );
  return checkout;
}
export function writeLargeFileOutput({
  fixture,
  checkout = fixture.repository,
  scenario = "accepted",
  phase = "payload",
}) {
  const root = ownedFixture(fixture, checkout);
  recipeOutput(root, fixture.namespace, scenario, phase);
}

export function largeFileScenario(id) {
  const scenarios = {
    "lfs-tool-missing": {
      stage: "source-preflight",
      reason: /requires git-lfs|Git LFS.*unavailable/i,
    },
    "lfs-object-missing": {
      stage: "source-preflight",
      reason: /required LFS object.*missing|LFS object.*cache/i,
    },
    "lfs-object-corrupt": {
      stage: "source-preflight",
      reason: /LFS (?:cache )?object.*(?:digest|size|hash|integrity)/i,
    },
    scope: { stage: "collection", reason: /outside scope/i },
    secret: {
      stage: "collection",
      reason: /suspected.*(?:credential|secret|GitHub token)|secret material/i,
    },
    symlink: {
      stage: "filesystem-materialization",
      reason:
        /^symlink artifacts support Git-object-only operations, not filesystem materialization$/,
    },
  };
  assert.ok(Object.hasOwn(scenarios, id), "unknown refusal scenario");
  // Symlinks may retain exact raw target Git blobs in intent/ready; this is not PR or
  // filesystem authority. The installed driver independently proves that retained identity.
  return { id, ...scenarios[id], remoteWritesAllowed: id === "symlink" };
}
export function assertLargeFileRefusal(observation) {
  const scenario = largeFileScenario(observation.scenario);
  assert.equal(observation.outcome, "refused");
  assert.equal(observation.stage, scenario.stage);
  assert.ok(typeof observation.reason === "string" && observation.reason.length <= 4096);
  assert.ok(
    !observation.reason.includes("Q".repeat(40)),
    "refusal leaked the synthetic credential canary",
  );
  assert.match(observation.reason, scenario.reason);
  if (observation.contentUploads !== undefined) {
    assert.equal(
      observation.contentUploadEvidence,
      "instrumented-content-write-count",
      "upload count lacks observation provenance",
    );
    assert.ok(Number.isSafeInteger(observation.contentUploads) && observation.contentUploads >= 0);
    if (!scenario.remoteWritesAllowed)
      assert.equal(observation.contentUploads, 0, "refused content reached external publication");
  } else assert.equal(observation.contentUploadEvidence, undefined);
  assert.equal(observation.artifactPublished, false);
  if (scenario.stage === "source-preflight") assert.equal(observation.modelCalls, 0);
  // Counters come from the driver's actual installed observation, never inferred by this helper.
  return {
    scenario: scenario.id,
    boundary: scenario.stage,
    refused: true,
    uploadAbsence:
      observation.contentUploads === undefined
        ? "unavailable"
        : observation.contentUploads === 0
          ? "observed-zero"
          : "not-absent",
  };
}

export function largeFileObjectiveBody(namespace) {
  const p = largeFilePaths(namespace);
  return `Qualify deterministic large-file handling for namespace ${namespace}. Create exactly three linear Work Items in this order, never parallel roots. Use existing committed ${p.recipe}; do not rewrite the recipe, test, attributes, or LFS files. Do not fetch/install/upload LFS or add dependencies.\n\n1. Payload (the sole root): run node ${p.recipe} payload. Create only ${p.payload}, exactly 6291500 bytes of valid PCM WAV from the existing bounded deterministic recipe. It must produce a genuine binary Git patch above 5 MiB.\n2. Metadata (depends on Payload): run node ${p.recipe} metadata. Create only ${p.executable} (Git mode 100755) and ${p.metadata}, with exact recipe bytes.\n3. Verification join (depends on Payload and Metadata): run node ${p.recipe} join. Create only ${p.result}; independently check all generated content using node ${p.recipe} verify and node --test ${p.test}.\n\nEach Work Item validates with node --test ${p.test}. The final result must preserve both existing canonical and legacy LFS pointers in Git, while their unchanged locally provisioned objects remain available. No other paths may change. Real installed workers and independent validation/review are required; fixture generation alone is not an execution pass.\n`;
}

export function observeLargeFileTree({
  repository,
  treeish,
  fixture,
  baseSha = fixture.baseSha,
  patch,
}) {
  assert.match(treeish, /^[a-f0-9]{40}$/);
  assert.match(baseSha, /^[a-f0-9]{40}$/);
  const deadline = Date.now() + 120_000;
  const treeSha = gitText(
    repository,
    ["rev-parse", `${treeish}^{tree}`],
    undefined,
    1024,
    deadline,
  );
  const baseTreeSha = gitText(
    repository,
    ["rev-parse", `${baseSha}^{tree}`],
    undefined,
    1024,
    deadline,
  );
  const entries = listing(
    repository,
    treeSha,
    largeFilePaths(fixture.namespace).prefix,
    deadline,
  ).filter((entry) => entry.type === "blob");
  assert.ok(
    entries.length <= 16 && entries.every((entry) => entry.bytes <= LARGE_FILE_AUDIO_BYTES),
  );
  const expected = new Map(
    [...baselineFiles(fixture.namespace).files, ...outputFiles(fixture.namespace)].map((file) => [
      file.path,
      file,
    ]),
  );
  const files = entries.map((entry) => {
    const spec = expected.get(entry.path);
    assert.ok(spec, "unexpected path in qualification namespace");
    const bytes = git(
      repository,
      ["cat-file", "blob", entry.oid],
      undefined,
      entry.bytes + 1024,
      deadline,
    );
    assert.equal(gitOid("blob", bytes), entry.oid);
    assert.equal(bytes.length, entry.bytes);
    assert.ok(bytes.equals(spec.bytes), "actual Git blob differs from the deterministic fixture");
    assert.equal(entry.mode, spec.mode ?? "100644");
    return {
      path: entry.path,
      mode: entry.mode,
      gitBlobOid: entry.oid,
      bytes: bytes.length,
      digest: hash(bytes),
      mediaType: spec.mediaType ?? "unknown",
      generated: spec.generated ?? false,
    };
  });
  for (const file of baselineFiles(fixture.namespace).files)
    assert.ok(
      files.some((observed) => observed.path === file.path),
      "baseline/LFS pointer missing",
    );
  let patchProof;
  if (patch !== undefined) {
    assert.ok(
      patch instanceof Uint8Array && patch.byteLength > 0 && patch.byteLength <= MAX_PATCH_BYTES,
    );
    ownedFixture(fixture);
    assert.ok(
      fs.readdirSync(fixture.root).filter((name) => name.startsWith("patch-proof-")).length < 16,
      "fixture patch-proof directory bound exceeded",
    );
    const proof = fs.mkdtempSync(join(fixture.root, "patch-proof-"));
    git(
      proof,
      ["init", "--quiet", "--template=", "--object-format=sha1"],
      undefined,
      1024,
      deadline,
    );
    assert.equal(importBase(repository, proof, baseSha, deadline), baseTreeSha);
    git(
      proof,
      ["apply", "--cached", "--binary", "--whitespace=error-all", "-"],
      patch,
      1024,
      deadline,
    );
    const appliedTreeSha = gitText(proof, ["write-tree"], undefined, 1024, deadline);
    assert.equal(
      appliedTreeSha,
      treeSha,
      "actual patch does not produce the independently observed Git tree",
    );
    patchProof = { bytes: patch.byteLength, digest: hash(patch), appliedTreeSha };
  }
  return {
    baseSha,
    baseTreeSha,
    treeSha,
    files,
    ...(patchProof ? { patchProof } : {}),
    provenance: "independent-local-raw-git-object-read",
  };
}
export function assertLargeFileFinalTree({ fixture, observation }) {
  const expected = [...baselineFiles(fixture.namespace).files, ...outputFiles(fixture.namespace)];
  assert.equal(observation.provenance, "independent-local-raw-git-object-read");
  assert.equal(observation.files.length, expected.length);
  for (const spec of expected) {
    const actual = observation.files.find((file) => file.path === spec.path);
    assert.ok(actual, "required final file missing");
    for (const [key, value] of Object.entries(describeFile(spec))) assert.equal(actual[key], value);
    assert.equal(actual.gitBlobOid, gitOid("blob", spec.bytes));
  }
  return { treeSha: observation.treeSha, files: observation.files, lfsPointersPreserved: true };
}
export function assertLargeFileArtifact({ fixture, artifact, observation, patch, phase }) {
  const expected = phaseFiles(fixture.namespace, phase);
  assert.equal(artifact.protocol, "clockgrove.factory/artifact-v1");
  assert.equal(artifact.outcome, "succeeded");
  assert.equal(artifact.baseSha, observation.baseSha);
  assert.equal(observation.provenance, "independent-local-raw-git-object-read");
  assert.ok(
    Array.isArray(artifact.changedPaths) && artifact.changedPaths.length === expected.length,
  );
  assert.ok(Array.isArray(observation.files) && observation.files.length <= 16);
  assert.deepEqual([...artifact.changedPaths].sort(), expected.map((file) => file.path).sort());
  const manifest = artifact.fileManifest;
  assert.equal(manifest?.version, 1);
  assert.equal(manifest.baseTreeSha, observation.baseTreeSha);
  assert.equal(manifest.resultTreeSha, observation.treeSha);
  assert.equal(manifest.files.length, expected.length);
  for (const spec of expected) {
    const file = manifest.files.find((item) => item.path === spec.path);
    const actual = observation.files.find((item) => item.path === spec.path);
    assert.ok(file && actual, "artifact manifest path lacks actual Git content");
    assert.deepEqual(file, {
      path: spec.path,
      action: "write",
      mode: spec.mode,
      bytes: spec.bytes.length,
      digest: hash(spec.bytes),
      mediaType: spec.mediaType,
      generated: spec.generated,
    });
    for (const [key, value] of Object.entries(describeFile(spec))) assert.equal(actual[key], value);
    assert.equal(actual.gitBlobOid, gitOid("blob", spec.bytes));
  }
  assert.ok(
    patch instanceof Uint8Array && patch.byteLength > 0 && patch.byteLength <= MAX_PATCH_BYTES,
  );
  const bytes = Buffer.from(patch);
  assert.deepEqual(
    observation.patchProof,
    { bytes: bytes.length, digest: hash(bytes), appliedTreeSha: observation.treeSha },
    "artifact patch lacks independent exact-tree application proof",
  );
  if (phase === "payload") {
    assert.ok(bytes.length > INLINE_BYTES, "fixture did not exercise oversized transfer");
    const payload = artifact.payload;
    assert.equal(payload?.kind, "git-patch-chunks-v1");
    assert.equal(payload.bytes, bytes.length);
    assert.equal(payload.digest, hash(bytes));
    assert.equal(payload.chunks.length, Math.ceil(bytes.length / CHUNK_BYTES));
    for (const [index, chunk] of payload.chunks.entries()) {
      const part = bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
      assert.deepEqual(chunk, { digest: hash(part), bytes: part.length });
    }
    assert.equal(
      artifact.patch,
      `# Factory content-addressed Git patch sha256:${hash(bytes)} bytes:${bytes.length}\n`,
    );
  } else {
    assert.equal(artifact.payload, undefined);
    assert.equal(artifact.patch, bytes.toString("utf8"));
  }
  // Rebuild the public artifact-v1 digest with normalized field order, independently of runtime.
  const normalizedManifest = {
    version: 1,
    baseTreeSha: manifest.baseTreeSha,
    resultTreeSha: manifest.resultTreeSha,
    files: manifest.files.map((file) => ({
      path: file.path,
      action: file.action,
      mode: file.mode,
      bytes: file.bytes,
      digest: file.digest,
      mediaType: file.mediaType,
      generated: file.generated,
    })),
  };
  const normalizedPayload = artifact.payload
    ? {
        kind: artifact.payload.kind,
        digest: artifact.payload.digest,
        bytes: artifact.payload.bytes,
        chunks: artifact.payload.chunks.map((chunk) => ({
          digest: chunk.digest,
          bytes: chunk.bytes,
        })),
      }
    : undefined;
  const digest = createHash("sha256")
    .update(artifact.baseSha)
    .update("\0")
    .update(artifact.changedPaths.slice().sort().join("\0"))
    .update("\0")
    .update(artifact.patch)
    .update("\0content-v1\0")
    .update(
      JSON.stringify({
        ...(normalizedPayload ? { payload: normalizedPayload } : {}),
        fileManifest: normalizedManifest,
      }),
    )
    .digest("hex");
  assert.equal(artifact.digest, digest, "artifact content digest differs");
  return {
    phase,
    artifactDigest: artifact.digest,
    resultTreeSha: observation.treeSha,
    patchBytes: bytes.length,
    patchSha256: hash(bytes),
    oversized: bytes.length > INLINE_BYTES,
  };
}
