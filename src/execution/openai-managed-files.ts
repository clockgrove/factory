import { packageManagerUpdate } from "../package-manager-update.js";
import { prepareManagedBase } from "./managed-base.js";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { create, extract, list } from "tar";
import type {
  ContentStore,
  ExecutionRequest,
  HarnessRequest,
} from "../contracts.js";
import { importSourceAssets } from "../media.js";
import { addWorktree, pinnedGitRaw } from "../process.js";

export const OPENAI_INPUT_MAX_BYTES = 5 * 1024 * 1024;
export const OPENAI_OUTPUT_MAX_BYTES = 200 * 1024 * 1024;
export const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Hosted Python and tar operate on ordinary bytes, never model-encoded file content. */
export const openAIExportScript = `import os, json, subprocess, tarfile, hashlib
root = '/workspace/repo'
os.chdir(root)
with open('/workspace/factory-binding.json') as f: binding=json.load(f)
if subprocess.check_output(['git','rev-parse','HEAD']).decode().strip() != binding['baseSha']: raise RuntimeError('Worker changed HEAD')
paths=set(p.decode() for p in subprocess.check_output(['git','ls-files','-co','--exclude-standard','-z']).split(b'\\0') if p)
for name in ['.factory-inputs','.factory-media','.factory-assets.json','.factory-discovery.json','.factory-handoff.json']:
 if os.path.isdir(name):
  for directory,dirs,files in os.walk(name):
   paths.update(os.path.join(directory,f) for f in files)
 elif os.path.lexists(name): paths.add(name)
paths.discard('.factory-result.json')
files=[]
for path in sorted(paths):
 if not os.path.lexists(path): continue
 if not os.path.isfile(path) or os.path.islink(path): raise RuntimeError('Unsupported result entry '+path)
 digest=hashlib.sha256()
 with open(path,'rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''): digest.update(chunk)
 files.append({'path':path,'mode':'100755' if os.stat(path).st_mode & 0o111 else '100644','bytes':os.stat(path).st_size,'digest':digest.hexdigest()})
binding['files']=files
with open('.factory-result.json','w') as f: json.dump(binding,f)
paths.add('.factory-result.json')
os.makedirs('/workspace/outputs',exist_ok=True)
with tarfile.open('/workspace/outputs/factory-result.tar','w',format=tarfile.PAX_FORMAT) as archive:
 for path in sorted(paths):
  if not os.path.lexists(path): continue
  if not os.path.isfile(path) or os.path.islink(path): raise RuntimeError('Unsupported result entry '+path)
  archive.add(path,arcname=path,recursive=False)
`;

export async function prepareOpenAIInput(args: {
  checkout: string;
  root: string;
  request: ExecutionRequest;
  store: ContentStore;
}): Promise<{
  archive: Buffer;
  request: ExecutionRequest;
  harnessRequest: HarnessRequest;
}> {
  const { checkout, root, request, store } = args;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const repo = join(root, "repo");
  await prepareManagedBase(checkout, repo, request.baseSha);
  const sourceAssets = await importSourceAssets(
    store,
    repo,
    request.item,
    request.objectiveBody,
  );
  const boundSources: NonNullable<HarnessRequest["sourceAssets"]> = [];
  let privateIndex = 0;
  for (const source of sourceAssets) {
    let path = `/workspace/repo/${source.binding.path}`;
    if (
      source.binding.kind === "local" ||
      source.binding.kind === "github-attachment"
    ) {
      const relative = `.factory-inputs/source-${privateIndex++}`;
      mkdirSync(dirname(join(repo, relative)), {
        recursive: true,
        mode: 0o700,
      });
      await store.materialize(source.ref, join(repo, relative));
      path = `/workspace/repo/${relative}`;
    }
    boundSources.push({ ...source, path });
  }
  const selectedAssets: NonNullable<HarnessRequest["selectedAssets"]> = [];
  for (const [index, selected] of (request.selectedAssets ?? []).entries()) {
    const relative = `.factory-inputs/selected-${index}`;
    mkdirSync(dirname(join(repo, relative)), { recursive: true, mode: 0o700 });
    await store.materialize(selected.ref, join(repo, relative));
    selectedAssets.push({ ...selected, path: `/workspace/repo/${relative}` });
  }
  const file = join(root, "input.tar");
  await create({ cwd: root, file, portable: true, noMtime: true }, ["repo"]);
  const archive = readFileSync(file);
  if (archive.length > OPENAI_INPUT_MAX_BYTES)
    throw new Error(
      "OpenAI inline input exceeds the documented 5 MiB file limit",
    );
  return {
    archive,
    request: { ...request, sourceAssets },
    harnessRequest: {
      item: request.item,
      packageManagerUpdate: packageManagerUpdate(request.objectiveBody ?? ""),
      worktree: "/workspace/repo",
      attemptId: request.attemptId,
      sourceAssets: boundSources,
      selectedAssets,
    },
  };
}

/** Validate every archive header before writing any provider-controlled path. */
export async function importOpenAIResult(args: {
  file: string;
  checkout: string;
  worktree: string;
  baseSha: string;
  attemptId: string;
  inputDigest: string;
}): Promise<void> {
  const { file, checkout, worktree, baseSha, attemptId, inputDigest } = args;
  if (lstatSync(file).size > OPENAI_OUTPUT_MAX_BYTES)
    throw new Error("OpenAI artifact exceeds its documented size limit");
  const names = new Set<string>();
  let total = 0;
  let invalid: string | undefined;
  await list({
    file,
    strict: true,
    onReadEntry(entry) {
      const path = entry.path;
      if (
        !path ||
        path.includes("\\") ||
        path
          .split("/")
          .some(
            (p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git",
          ) ||
        entry.type !== "File" ||
        (entry.mode !== undefined && (entry.mode & 0o7000) !== 0) ||
        names.has(path)
      )
        invalid = "Managed result has unsafe or duplicate archive entries";
      names.add(path);
      total += entry.size;
      if (total > OPENAI_OUTPUT_MAX_BYTES)
        invalid = "Managed result expands beyond provider artifact limit";
    },
  });
  if (invalid) throw new Error(invalid);
  if (!names.has(".factory-result.json"))
    throw new Error("Managed result binding is missing");
  mkdirSync(dirname(worktree), { recursive: true, mode: 0o700 });
  await addWorktree(checkout, worktree, baseSha);
  for (const path of pinnedGitRaw(worktree, "ls-files", "-z")
    .toString("utf8")
    .split("\0")
    .filter(Boolean)) {
    const absolute = join(worktree, path);
    if (existsSync(absolute)) rmSync(absolute);
  }
  await extract({
    file,
    cwd: worktree,
    strict: true,
    preserveOwner: false,
    noChmod: false,
  });
  const binding: unknown = JSON.parse(
    readFileSync(join(worktree, ".factory-result.json"), "utf8"),
  );
  if (
    !binding ||
    typeof binding !== "object" ||
    (binding as Record<string, unknown>).baseSha !== baseSha ||
    (binding as Record<string, unknown>).attemptId !== attemptId ||
    (binding as Record<string, unknown>).inputDigest !== inputDigest
  )
    throw new Error("Managed result belongs to a different base or attempt");
  const entries = (binding as Record<string, unknown>).files;
  if (!Array.isArray(entries) || entries.length !== names.size - 1)
    throw new Error("Managed result inventory does not match archive entries");
  const remaining = new Set(names);
  remaining.delete(".factory-result.json");
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Invalid managed result inventory entry");
    const value = entry as Record<string, unknown>;
    if (
      typeof value.path !== "string" ||
      !remaining.delete(value.path) ||
      !["100644", "100755"].includes(String(value.mode)) ||
      !Number.isSafeInteger(value.bytes) ||
      Number(value.bytes) < 0 ||
      typeof value.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.digest)
    )
      throw new Error("Invalid managed result inventory identity");
    const path = join(worktree, value.path);
    const bytes = readFileSync(path);
    const mode = lstatSync(path).mode & 0o111 ? "100755" : "100644";
    if (
      bytes.length !== value.bytes ||
      sha256(bytes) !== value.digest ||
      mode !== value.mode
    )
      throw new Error("Managed result content differs from exported inventory");
  }
  if (remaining.size)
    throw new Error("Managed result inventory omits archive entries");
  rmSync(join(worktree, ".factory-result.json"));
}
