import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executionAffectingReason } from "../approval.js";
import {
  MAX_ARTIFACT_PATCH_BYTES,
  assertArtifactScope,
  verifyArtifact,
  materializeArtifactPatch,
  type NormalizedArtifact,
} from "../execution/artifacts.js";
import { assertNoSecretMaterial, gitSha } from "../protocol/limits.js";
import type { WorkerPacket } from "../protocol/worker-packet.js";
import { runContainedProcess, sanitizedWorkerEnvironment } from "../runtime/process-group.js";
import { inspectPatchManifest } from "../runtime/artifact-patch.js";
import type { PublicationStore } from "./publisher.js";

// GitHub's ordinary Git-blob read contract is bounded at 100 MB. Large assets
// outside that contract require their repository's separate asset/LFS policy.
export const MAX_SIBLING_REFRESH_BLOB_BYTES = 100 * 1024 * 1024;
const PREPARATION_TIMEOUT_MS = 120_000;
const gitOptions = [
  "--no-optional-locks",
  "--no-replace-objects",
  "--literal-pathspecs",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.sparseCheckout=false",
  "-c",
  "core.splitIndex=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "credential.helper=",
];

// The contained-process transport is text-only. This fixed host-owned bridge
// captures raw Git bytes into one private file, never executing repository code
// or interpolating a filename into shell syntax. Its Git child shares the owned
// process group and has independent time/output bounds.
const rawBlobBridge = `
const {execFileSync} = require('node:child_process');
const {writeFileSync} = require('node:fs');
try {
  const [args, output, size, timeout] = process.argv.slice(1);
  const bytes = execFileSync('git', JSON.parse(args), {
    encoding: 'buffer', maxBuffer: Number(size) + 1, timeout: Number(timeout),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (bytes.length !== Number(size)) process.exit(2);
  writeFileSync(output, bytes, {flag: 'wx', mode: 0o600});
} catch { process.exit(2); }
`;

/** Prepare/upload a proposed tree using only raw Git objects and a private index.
 * There is no checkout, ref mutation, hook/filter execution, or validation claim. */
export async function prepareSiblingRefreshTree(input: {
  repository: string;
  artifact: NormalizedArtifact;
  packet: WorkerPacket;
  store: Pick<PublicationStore, "readCommit" | "createBlob" | "createTree">;
  assertCurrent: () => Promise<void>;
}): Promise<string> {
  const artifact = verifyArtifact(input.artifact);
  if (
    artifact.outcome !== "succeeded" ||
    !artifact.patch.trim() ||
    artifact.baseSha !== input.packet.baseSha
  )
    throw new Error("sibling tree preparation requires an exact executable artifact base");
  assertArtifactScope(artifact, input.packet.allowedPaths);
  if (artifact.changedPaths.some((path) => executionAffectingReason(path) !== null))
    throw new Error("sibling tree preparation touches a sensitive surface");
  assertNoSecretMaterial({ patch: artifact.patch, logs: artifact.logs }, "artifact");
  await input.assertCurrent();
  const root = await mkdtemp(join(tmpdir(), "factory-sibling-index-"));
  const deadline = Date.now() + PREPARATION_TIMEOUT_MS;
  const env = sanitizedWorkerEnvironment(process.env);
  // An inherited alternate index, replacement object, config injection or lazy
  // fetch must not redirect this object-only operation or invoke a helper.
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  delete env.NODE_OPTIONS;
  Object.assign(env, {
    GIT_INDEX_FILE: join(root, "index"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
  const cwd = resolve(input.repository);
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) throw new Error("sibling tree preparation deadline exhausted");
    return value;
  };
  const run = async (command: string, args: string[], maxOutputBytes: number) => {
    // Local object/index plumbing grants no execution or publication authority.
    // Reconstruct remote admission at entry and before EACH upload, not before
    // every local read; successor admission can otherwise repeat a full graph.
    const result = await runContainedProcess({
      command,
      args,
      cwd,
      env,
      timeoutMs: remaining(),
      maxOutputBytes,
    });
    if (result.exitCode !== 0 || result.timedOut || result.stdout.startsWith("[output truncated"))
      throw new Error("sibling tree object operation failed or exceeded its bound");
    return result.stdout;
  };
  const git = (args: string[], maximum = MAX_ARTIFACT_PATCH_BYTES + 1024) =>
    run("git", [...gitOptions, ...args], maximum);
  try {
    const baseSha = gitSha.parse(
      (await git(["rev-parse", "--verify", `${artifact.baseSha}^{commit}`])).trim(),
    );
    if (baseSha !== artifact.baseSha) throw new Error("sibling tree local base identity differs");
    const base = await input.store.readCommit(baseSha);
    if (
      base.oid !== baseSha ||
      base.treeOid !== (await git(["rev-parse", `${baseSha}^{tree}`])).trim()
    )
      throw new Error("sibling tree remote base identity differs");
    const patchPath = join(root, "artifact.patch");
    await materializeArtifactPatch(artifact, patchPath);
    const trustedManifest =
      artifact.fileManifest ??
      (await inspectPatchManifest(input.repository, baseSha, patchPath, artifact.changedPaths));
    await git(["read-tree", baseSha]);
    await git(["apply", "--cached", "--binary", "--whitespace=error-all", patchPath]);
    const outputTreeSha = gitSha.parse((await git(["write-tree"])).trim());
    if (
      trustedManifest.baseTreeSha !== base.treeOid ||
      trustedManifest.resultTreeSha !== outputTreeSha
    )
      throw new Error("sibling preparation differs from artifact content manifest");
    const changed = (
      await git([
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "-r",
        "-z",
        base.treeOid,
        outputTreeSha,
      ])
    )
      .split("\0")
      .filter(Boolean)
      .sort();
    if (JSON.stringify(changed) !== JSON.stringify([...artifact.changedPaths].sort()))
      throw new Error("prepared tree paths differ from artifact manifest");
    const entries: Parameters<PublicationStore["createTree"]>[0]["entries"] = [];
    const uploaded = new Set<string>();
    for (const path of changed) {
      const raw = await git(["ls-tree", "-z", outputTreeSha, "--", path]);
      if (!raw) {
        entries.push({ path, mode: "100644", type: "blob", sha: null });
        continue;
      }
      const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(raw);
      if (!match || match[3] !== path)
        throw new Error("prepared tree entry is not an exact supported blob");
      const blobOid = match[2]!;
      if (!uploaded.has(blobOid)) {
        const sizeText = (await git(["cat-file", "-s", blobOid], 128)).trim();
        const size = Number(sizeText);
        if (
          !/^(0|[1-9][0-9]*)$/.test(sizeText) ||
          !Number.isSafeInteger(size) ||
          size > MAX_SIBLING_REFRESH_BLOB_BYTES
        )
          throw new Error("sibling tree blob exceeds the ordinary Git asset bound");
        const blobPath = join(root, blobOid);
        await run(
          process.execPath,
          [
            "--input-type=commonjs",
            "-e",
            rawBlobBridge,
            JSON.stringify([...gitOptions, "cat-file", "blob", blobOid]),
            blobPath,
            String(size),
            String(remaining()),
          ],
          1024,
        );
        if ((await stat(blobPath)).size !== size) throw new Error("raw blob size changed");
        const content = await readFile(blobPath);
        const actual = createHash("sha1")
          .update(`blob ${content.length}\0`)
          .update(content)
          .digest("hex");
        if (actual !== blobOid) throw new Error("raw blob object identity changed");
        assertNoSecretMaterial(content.toString("latin1"), "sibling publication content");
        await input.assertCurrent();
        remaining();
        if ((await input.store.createBlob(content)) !== blobOid)
          throw new Error("uploaded blob identity differs from prepared raw object");
        uploaded.add(blobOid);
      }
      entries.push({
        path,
        mode: match[1] as "100644" | "100755" | "120000",
        type: "blob",
        sha: blobOid,
      });
    }
    await input.assertCurrent();
    remaining();
    const uploadedTree = await input.store.createTree({ baseTreeOid: base.treeOid, entries });
    if (uploadedTree !== outputTreeSha) throw new Error("uploaded tree differs from prepared tree");
    return outputTreeSha;
  } finally {
    // root is this invocation's exact mkdtemp result, never a supplied checkout.
    await rm(root, { recursive: true, force: true });
  }
}
