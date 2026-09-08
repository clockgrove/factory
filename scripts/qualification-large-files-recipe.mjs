/** Standalone qualification recipe template. The harness substitutes exactly one namespace.
 * Keep this file as raw source: never serialize functions from a transformed module.
 * No provider, network, package install or Git operation is performed here.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const namespace = "__FACTORY_LARGE_FILE_NAMESPACE__";
const recipeVersion = "factory-large-files-fixture-v2";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

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

function largeFilePaths(namespace) {
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
    `${JSON.stringify({ recipe: recipeVersion, bytes: audio.length, sha256: hash(audio), format: "PCM-u8-mono-8000Hz" }, null, 2)}\n`,
  );
  const executable = Buffer.from(
    `#!/usr/bin/env node\nimport { verify } from "../large-files-recipe.mjs";\nverify("metadata");\n`,
  );
  const result = Buffer.from(
    `${JSON.stringify({ recipe: recipeVersion, verified: true, payloadSha256: hash(audio), metadataSha256: hash(metadata), executableSha256: hash(executable) }, null, 2)}\n`,
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

assertNamespace(namespace);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function verify(phase = "present") {
  const files = outputFiles(namespace);
  const required =
    phase === "payload"
      ? ["payload"]
      : phase === "metadata"
        ? ["payload", "metadata"]
        : phase === "join"
          ? ["payload", "metadata", "join"]
          : [];
  for (const file of files) {
    if (!fs.existsSync(join(root, file.path)) && !required.includes(file.phase)) continue;
    const actual = regularBytes(root, file.path, file.bytes.length);
    assert.ok(actual.bytes.equals(file.bytes), "fixture output bytes differ");
    assert.equal(actual.mode, file.mode, "fixture output mode differs");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const phase = process.argv[2];
  if (phase === "verify") verify("join");
  else if (["scope", "secret", "symlink"].includes(phase))
    recipeOutput(root, namespace, phase, "payload");
  else {
    if (phase === "metadata") verify("payload");
    if (phase === "join") verify("metadata");
    recipeOutput(root, namespace, "accepted", phase);
    verify(phase);
  }
}
