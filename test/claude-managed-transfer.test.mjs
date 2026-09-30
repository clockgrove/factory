import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, unlinkSync, symlinkSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CLAUDE_EXPORT_SCRIPT, claudeByteDigest, parseClaudeResultSnapshot, materializeClaudeSnapshot } from '../dist/execution/claude-managed-transfer.js';
const binding = { attemptId: 'owned', baseSha: 'a'.repeat(40), inputDigest: 'b'.repeat(64) };
const file = (path, bytes, mode = '100644') => ({ path, mode, sha256: claudeByteDigest(bytes), bytes: bytes.length, content: bytes.toString('base64') });
const decode = files => parseClaudeResultSnapshot(Buffer.from(JSON.stringify({ ...binding, files })), binding);
test('Claude deterministic exporter round-trips binary, deletion, links and declared ignored asset bytes', () => {
 const root=mkdtempSync(join(tmpdir(),'claude-transfer-'));try{
 const cwd=join(root,'work');mkdirSync(cwd);const git=(...args)=>execFileSync('git',args,{cwd,stdio:'pipe'});
 git('init','-q');writeFileSync(join(cwd,'removed'),'old');writeFileSync(join(cwd,'.gitignore'),'media/\n');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','baseline');unlinkSync(join(cwd,'removed'));
 const binary=Buffer.from(Array.from({length:4096},(_,i)=>i%256));writeFileSync(join(cwd,'binary.dat'),binary);symlinkSync('binary.dat',join(cwd,'link'));mkdirSync(join(cwd,'media'));writeFileSync(join(cwd,'media/approved.bin'),binary);
 writeFileSync(join(cwd,'.factory-assets.json'),JSON.stringify({sets:[{members:[{path:'media/approved.bin'}]}]}));
 const script=join(root,'export.mjs');writeFileSync(script,CLAUDE_EXPORT_SCRIPT);const receipt=join(root,'binding.json');writeFileSync(receipt,JSON.stringify(binding));const output=join(root,'result.json');execFileSync(process.execPath,[script,receipt,output],{cwd});
 const result=parseClaudeResultSnapshot(readFileSync(output),binding);assert.ok(!result.files.some(f=>f.path==='removed'));assert.ok(result.files.some(f=>f.path==='media/approved.bin'));const dest=join(root,'result');materializeClaudeSnapshot(dest,result);assert.deepEqual(readFileSync(join(dest,'binary.dat')),binary);assert.deepEqual(readFileSync(join(dest,'media/approved.bin')),binary);assert.equal(readlinkSync(join(dest,'link')),'binary.dat');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('Claude rejects corrupt, truncated, misbound and unsafe output before materialization', () => {
 const entry=file('ok',Buffer.from([0,255,128]));
 for(const change of [v=>{v.inputDigest='c'.repeat(64);},v=>{v.baseSha='d'.repeat(40);},v=>{v.attemptId='other';},v=>{v.files[0].content='AA==';},v=>{v.files[0].bytes=0;},v=>{v.files[0].path='../escape';},v=>{v.files[0].path='/outside';},v=>{v.files[0].path='.git/config';},v=>{v.files[0].path='dir\\file';},v=>{v.files.push(v.files[0]);},v=>{v.files.push(file('ok/nested',Buffer.from('x')));}]){
 const value=structuredClone({...binding,files:[entry]});change(value);assert.throws(()=>parseClaudeResultSnapshot(Buffer.from(JSON.stringify(value)),binding));
 }
 assert.equal(decode([entry]).files.length,1);
});
