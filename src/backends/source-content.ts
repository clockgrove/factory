import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializePinnedCompilationTree } from "../execution/pinned-compilation-tree.js";
import { inspectContentFile } from "../execution/artifact-content.js";
import { inspectPinnedLfs } from "../repository-profiles/git-lfs.js";
import { streamCommandFile, streamGitFile } from "../runtime/artifact-patch.js";
import type { SandboxBootstrapFile } from "./sandbox-common.js";

export const MAX_SOURCE_TRANSFER_BYTES = 256 * 1024 * 1024;
export async function repositoryArchiveFile(repository: string, baseSha: string) {
  const lfs = await inspectPinnedLfs(repository, baseSha);
  if (lfs.assets.length)
    throw new Error(
      "remote source transport does not support LFS hydration; select a local backend with verified existing LFS objects",
    );
  const prepared = await materializePinnedCompilationTree(repository, baseSha);
  let root: string;
  try {
    root = await mkdtemp(join(tmpdir(), "factory-source-content-"));
  } catch (error) {
    await prepared.dispose();
    throw error;
  }
  try {
    const treePath = join(root, "base-tree");
    await streamGitFile(prepared.path, ["rev-parse", "HEAD^{tree}"], treePath, 42);
    const baseTreeSha = (await readFile(treePath, "utf8")).trim();
    if (!/^[a-f0-9]{40}$/.test(baseTreeSha)) throw new Error("invalid pinned source tree identity");
    const list = join(root, "paths");
    await writeFile(list, prepared.files.length ? prepared.files.join("\0") + "\0" : "", {
      mode: 0o600,
      flag: "wx",
    });
    const path = join(root, "source.tar");
    await streamCommandFile(
      "tar",
      ["-c", "--null", "--verbatim-files-from", "-T", list],
      prepared.path,
      path,
      MAX_SOURCE_TRANSFER_BYTES,
    );
    const content = await inspectContentFile(path, MAX_SOURCE_TRANSFER_BYTES);
    return {
      path,
      baseSha,
      baseTreeSha,
      digest: content.digest,
      bytes: content.bytes,
      remotePath: `factory/source-${content.digest}.tar`,
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  } finally {
    await prepared.dispose();
  }
}
export type SourceArchiveFile = Awaited<ReturnType<typeof repositoryArchiveFile>>;

/** SDK FileSystem.uploadFiles accepts local path strings and streams their bytes. */
export function sourceContentUploads(files: SandboxBootstrapFile[], archive: SourceArchiveFile) {
  const sourceName = `source-${archive.digest}.tar`;
  return [
    { source: archive.path, destination: archive.remotePath },
    ...files
      .filter((file) => file.path !== "factory/source.tar")
      .map((file) => {
        let content = file.content;
        if (file.path === "factory/run.sh" || file.path === "factory/validate.sh") {
          const script = content
            .toString("utf8")
            .replaceAll("source.tar", sourceName)
            .replace(
              "git commit -qm factory-base\n",
              `[ "$(git write-tree)" = '${archive.baseTreeSha}' ] || { echo 'source tree identity mismatch' >&2; exit 1; }\ngit commit --allow-empty -qm factory-base\n`,
            );
          const check = `printf '%s  %s\\n' '${archive.digest}' "$factory_root/${sourceName}" | sha256sum --check --status\n[ "$(wc -c < "$factory_root/${sourceName}")" -eq '${archive.bytes}' ]\n`;
          content = Buffer.from(
            script.replace(
              'factory_root="$PWD/factory"\n',
              'factory_root="$PWD/factory"\n' + check,
            ),
          );
        }
        if (file.path === "factory/validate.mjs") {
          const script = content
            .toString("utf8")
            .replaceAll("source.tar", sourceName)
            .replace(
              '  git(["commit", "-qm", "factory-base"]);',
              `  if (git(["write-tree"]).trim() !== '${archive.baseTreeSha}') throw new Error('source tree identity mismatch');\n  git(["commit", "--allow-empty", "-qm", "factory-base"]);`,
            );
          const check = `if (statSync(root + '${sourceName}').size !== ${archive.bytes} || execFileSync('sha256sum', [root + '${sourceName}'], {encoding:'utf8', maxBuffer:1024}).split(' ')[0] !== '${archive.digest}') throw new Error('source archive identity mismatch');\n`;
          content = Buffer.from(
            'import { statSync } from "node:fs";\n' + script.replace("try {\n", "try {\n" + check),
          );
        }
        return { source: content, destination: file.path };
      }),
    {
      source: Buffer.from(
        JSON.stringify({
          version: 1,
          baseSha: archive.baseSha,
          baseTreeSha: archive.baseTreeSha,
          digest: archive.digest,
          bytes: archive.bytes,
          lifecycle: "provider-ephemeral",
        }),
      ),
      destination: "factory/source-manifest.json",
    },
  ];
}
