import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializePinnedCompilationTree } from "../execution/pinned-compilation-tree.js";
import { inspectContentFile } from "../execution/artifact-content.js";
import { inspectPinnedLfs } from "../repository-profiles/git-lfs.js";
import { streamCommandFile } from "../runtime/artifact-patch.js";
import type { SandboxBootstrapFile } from "./sandbox-common.js";

export const MAX_SOURCE_TRANSFER_BYTES = 320 * 1024 * 1024;
export async function repositoryArchiveFile(repository: string, baseSha: string) {
  const lfs = await inspectPinnedLfs(repository, baseSha);
  if (lfs.assets.length) throw new Error("remote source transport does not support LFS hydration; select a local backend with verified existing LFS objects");
  const prepared = await materializePinnedCompilationTree(repository, baseSha);
  const root = await mkdtemp(join(tmpdir(), "factory-source-content-"));
  try {
    const list = join(root, "paths");
    await writeFile(list, prepared.files.join("\0") + "\0", { mode: 0o600, flag: "wx" });
    const path = join(root, "source.tar");
    await streamCommandFile("tar", ["-c", "--null", "--verbatim-files-from", "-T", list], prepared.path, path, MAX_SOURCE_TRANSFER_BYTES);
    const content = await inspectContentFile(path, MAX_SOURCE_TRANSFER_BYTES);
    return { path, baseSha, digest: content.digest, bytes: content.bytes,
      remotePath: `factory/source-${content.digest}.tar`,
      dispose: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  finally { await prepared.dispose(); }
}
export type SourceArchiveFile = Awaited<ReturnType<typeof repositoryArchiveFile>>;

/** SDK FileSystem.uploadFiles accepts local path strings and streams their bytes. */
export function sourceContentUploads(files: SandboxBootstrapFile[], archive: SourceArchiveFile) {
  const sourceName = `source-${archive.digest}.tar`;
  return [
    { source: archive.path, destination: archive.remotePath },
    ...files.filter((file) => file.path !== "factory/source.tar").map((file) => {
      let content = file.content;
      if (file.path === "factory/run.sh" || file.path === "factory/validate.sh") {
        const script = content.toString("utf8").replaceAll("source.tar", sourceName);
        const check = `printf '%s  %s\\n' '${archive.digest}' "$factory_root/${sourceName}" | sha256sum --check --status\n[ "$(wc -c < "$factory_root/${sourceName}")" -eq '${archive.bytes}' ]\n`;
        content = Buffer.from(script.replace('factory_root="$PWD/factory"\n', 'factory_root="$PWD/factory"\n' + check));
      }
      if (file.path === "factory/validate.mjs") {
        const script = content.toString("utf8").replaceAll("source.tar", sourceName);
        const check = `if (statSync(root + '${sourceName}').size !== ${archive.bytes} || execFileSync('sha256sum', [root + '${sourceName}'], {encoding:'utf8', maxBuffer:1024}).split(' ')[0] !== '${archive.digest}') throw new Error('source archive identity mismatch');\n`;
        content = Buffer.from('import { statSync } from "node:fs";\n' + script.replace("try {\n", "try {\n" + check));
      }
      return { source: content, destination: file.path };
    }),
    { source: Buffer.from(JSON.stringify({ version: 1, baseSha: archive.baseSha, digest: archive.digest, bytes: archive.bytes, lifecycle: "provider-ephemeral" })), destination: "factory/source-manifest.json" },
  ];
}
