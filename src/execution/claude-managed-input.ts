import {
  mkdirSync,
  readdirSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { ContentStore, ExecutionRequest } from "../contracts.js";
import { importSourceAssets } from "../media.js";
import { pinnedGit } from "../process.js";
import { prepareManagedBase } from "./managed-base.js";
import {
  claudeByteDigest,
  type ClaudeFile,
} from "./claude-managed-transfer.js";

export interface ClaudePreparedInput {
  path: string;
  digest: string;
  treeSha: string;
  files: Omit<ClaudeFile, "content">[];
  request: ExecutionRequest;
}
export async function prepareClaudeInput(
  checkout: string,
  directory: string,
  request: ExecutionRequest,
  store: ContentStore,
): Promise<ClaudePreparedInput> {
  mkdirSync(directory, { mode: 0o700 });
  const repo = join(directory, "repo");
  await prepareManagedBase(checkout, repo, request.baseSha);
  const sourceAssets = await importSourceAssets(
    store,
    repo,
    request.item,
    request.objectiveBody,
  );
  const privateSources = sourceAssets.filter(
    (source) =>
      source.binding.kind === "local" ||
      source.binding.kind === "github-attachment",
  );
  const selected = request.selectedAssets ?? [];
  if (privateSources.length || selected.length)
    mkdirSync(join(repo, ".factory-inputs"), { mode: 0o700 });
  for (const [index, source] of privateSources.entries())
    await store.materialize(
      source.ref,
      join(repo, ".factory-inputs", `source-${index}`),
    );
  for (const [index, asset] of selected.entries())
    await store.materialize(
      asset.ref,
      join(repo, ".factory-inputs", `selected-${index}`),
    );
  const files: ClaudeFile[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      if (!stat.isFile())
        throw new Error("Claude input supports regular files only");
      const content = readFileSync(path);
      files.push({
        path: relative(repo, path),
        mode: stat.mode & 0o111 ? "100755" : "100644",
        bytes: content.length,
        sha256: claudeByteDigest(content),
        content: content.toString("base64"),
      });
    }
  };
  visit(repo);
  const treeSha = pinnedGit(checkout, "rev-parse", `${request.baseSha}^{tree}`);
  const bytes = Buffer.from(
    JSON.stringify({ baseSha: request.baseSha, treeSha, files }),
  );
  const path = join(directory, "factory-input.json");
  writeFileSync(path, bytes, { mode: 0o600 });
  return {
    path,
    digest: claudeByteDigest(bytes),
    treeSha,
    files: files
      .filter((file) => !file.path.startsWith(".git/"))
      .map(({ content: _content, ...file }) => file),
    request: { ...request, sourceAssets },
  };
}

/** Only foreground synchronous operations. This immutable mounted script is the entire bootstrap tool allowance. */
export const CLAUDE_BOOTSTRAP_SCRIPT = String.raw`import {readFileSync,writeFileSync,mkdirSync,lstatSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const [inputPath,workspace,output,expectedDigest]=process.argv.slice(2);
const digest=b=>createHash('sha256').update(b).digest('hex');
const bytes=readFileSync(inputPath);if(digest(bytes)!==expectedDigest)throw new Error('Input digest mismatch');
const input=JSON.parse(bytes);mkdirSync(workspace,{mode:0o700});
for(const file of input.files){
 if(!file.path||file.path.includes('\\')||file.path.includes('\0')||file.path.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Unsafe input path');
 const bytes=Buffer.from(file.content,'base64');if(bytes.length!==file.bytes||digest(bytes)!==file.sha256||!['100644','100755'].includes(file.mode))throw new Error('Corrupt input file');
 const target=join(workspace,file.path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes,{flag:'wx',mode:file.mode==='100755'?0o755:0o644});
}
const git=(...args)=>execFileSync('git',args,{cwd:workspace,encoding:'utf8',env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'}}).trim();
if(git('rev-parse','HEAD')!==input.baseSha||git('rev-parse','HEAD^{tree}')!==input.treeSha)throw new Error('Wrong Git base');
git('diff','--exit-code','HEAD');
const files=input.files.filter(f=>!f.path.startsWith('.git/')).map(f=>{const path=join(workspace,f.path);const s=lstatSync(path);if(!s.isFile())throw new Error('Changed file kind');const b=readFileSync(path);return{path:f.path,mode:s.mode&0o111?'100755':'100644',bytes:b.length,sha256:digest(b)};});
const receipt={inputDigest:expectedDigest,baseSha:input.baseSha,treeSha:input.treeSha,files};
writeFileSync(output,JSON.stringify(receipt));
console.log(JSON.stringify(receipt));
`;
