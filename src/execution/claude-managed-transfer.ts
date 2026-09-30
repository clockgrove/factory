import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ClaudeFile {
  path: string;
  mode: "100644" | "100755" | "120000";
  sha256: string;
  bytes: number;
  content: string;
}
export interface ClaudeResultSnapshot {
  attemptId: string;
  baseSha: string;
  inputDigest: string;
  files: ClaudeFile[];
}
export function claudeByteDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    path
      .split("/")
      .every(
        (part) =>
          part &&
          part !== "." &&
          part !== ".." &&
          part.toLowerCase() !== ".git" &&
          part !== ".factory-inputs",
      )
  );
}
/** This wire format is emitted by the supplied deterministic script, never by asking a model to encode bytes. */
export function parseClaudeResultSnapshot(
  bytes: Uint8Array,
  binding: Omit<ClaudeResultSnapshot, "files">,
): ClaudeResultSnapshot {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (
    !object(value) ||
    value.attemptId !== binding.attemptId ||
    value.baseSha !== binding.baseSha ||
    value.inputDigest !== binding.inputDigest ||
    !Array.isArray(value.files) ||
    Object.keys(value).some(
      (key) => !["attemptId", "baseSha", "inputDigest", "files"].includes(key),
    )
  )
    throw new Error("Claude output has the wrong attempt/input/base binding");
  const paths = new Set<string>();
  for (const entry of value.files) {
    if (
      !object(entry) ||
      typeof entry.path !== "string" ||
      !safePath(entry.path) ||
      paths.has(entry.path) ||
      !["100644", "100755", "120000"].includes(String(entry.mode)) ||
      !Number.isSafeInteger(entry.bytes) ||
      Number(entry.bytes) < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      typeof entry.content !== "string" ||
      Object.keys(entry).some(
        (key) => !["path", "mode", "sha256", "bytes", "content"].includes(key),
      )
    )
      throw new Error("Claude output contains an unsafe or malformed file");
    const content = Buffer.from(entry.content, "base64");
    if (
      content.toString("base64") !== entry.content ||
      content.length !== entry.bytes ||
      claudeByteDigest(content) !== entry.sha256
    )
      throw new Error("Claude output file is truncated or corrupt");
    if (
      entry.mode === "120000" &&
      (content.includes(0) ||
        content.toString("utf8").length === 0 ||
        !Buffer.from(content.toString("utf8")).equals(content))
    )
      throw new Error("Claude output has an invalid symbolic link");
    paths.add(entry.path);
  }
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++)
      if (paths.has(parts.slice(0, index).join("/")))
        throw new Error("Claude output contains overlapping file paths");
  }
  return value as unknown as ClaudeResultSnapshot;
}
/** The destination must not exist. All bytes validate before any write; links are created last. */
export function materializeClaudeSnapshot(
  directory: string,
  snapshot: ClaudeResultSnapshot,
): void {
  const validated = parseClaudeResultSnapshot(
    Buffer.from(JSON.stringify(snapshot)),
    snapshot,
  );
  mkdirSync(directory, { mode: 0o700 });
  for (const file of validated.files)
    mkdirSync(dirname(join(directory, file.path)), { recursive: true });
  for (const file of validated.files.filter((file) => file.mode !== "120000"))
    writeFileSync(
      join(directory, file.path),
      Buffer.from(file.content, "base64"),
      { flag: "wx", mode: file.mode === "100755" ? 0o755 : 0o644 },
    );
  for (const file of validated.files.filter((file) => file.mode === "120000"))
    symlinkSync(
      Buffer.from(file.content, "base64").toString("utf8"),
      join(directory, file.path),
    );
}

/** Runs inside the hosted workspace after implementation. It reads bytes itself, including binaries.
 * git ls-files --cached --others --exclude-standard includes deletions (filtered by lstat) and intended additions.
 * LFS working-tree bytes are exported, not fetched or encoded by the language model.
 */
export const CLAUDE_EXPORT_SCRIPT = String.raw`import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync,readlinkSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const [bindingPath,output] = process.argv.slice(2);
const binding = JSON.parse(readFileSync(bindingPath,'utf8'));
const files=[];
const declared=[];
try{const sets=JSON.parse(readFileSync('.factory-assets.json','utf8')).sets;if(!Array.isArray(sets))throw new Error('Invalid AssetSet declaration');for(const set of sets)for(const member of set.members)declared.push(member.path);declared.push('.factory-assets.json');}catch(e){if(e.code!=='ENOENT')throw e;}
const paths=[...new Set([...declared,...execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean)])];
for(const path of paths){
 if(typeof path!=='string'||!path||path.includes('\\')||path.includes('\0')||path.split('/').some(p=>!p||p==='.'||p==='..'||p.toLowerCase()==='.git'))throw new Error('Unsafe output path');
 if(path.split('/').some(p=>p==='.factory-inputs'))continue;
 let stat;try{stat=lstatSync(path);}catch(e){if(e.code==='ENOENT')continue;throw e;}
 if(!stat.isFile()&&!stat.isSymbolicLink())throw new Error('Unsupported output file type: '+path);
 const bytes=stat.isSymbolicLink()?Buffer.from(readlinkSync(path)):readFileSync(path);
 files.push({path,mode:stat.isSymbolicLink()?'120000':stat.mode&0o111?'100755':'100644',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),content:bytes.toString('base64')});
}
writeFileSync(output,JSON.stringify({attemptId:binding.attemptId,baseSha:binding.baseSha,inputDigest:binding.inputDigest,files}));
`;
