/** Trusted, credential-free bootstrap. Git and LFS own their protocols; no repository code runs. */
export const daytonaPrepareScript = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync, spawnSync} = require('node:child_process');
(async () => {
 const [root, packageRoot, version, serialized] = process.argv.slice(1);
 const input = JSON.parse(serialized);
 if(Number(process.versions.node.split('.')[0]) < 22) throw Error('Node 22 or newer required');
 const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
 if(metadata.name !== '@clockgrove/factory' || metadata.version !== version) throw Error('Installed Factory version mismatch');
 fs.accessSync(path.join(packageRoot, 'dist/index.js'));
 const home = path.join(root, 'home');
 fs.mkdirSync(home, {recursive:true, mode:0o700});
 const env = {PATH:process.env.PATH, HOME:home, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_TERMINAL_PROMPT:'0', GIT_LFS_SKIP_SMUDGE:'1'};
 execFileSync('git', ['--version'], {env, stdio:'pipe'});
 execFileSync('git-lfs', ['version'], {env, stdio:'pipe'});
 const repo = path.join(root, 'repo');
 fs.mkdirSync(repo, {mode:0o700});
 const git = (...args) => execFileSync('git', ['-C',repo,...args], {env, encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();
 git('init','-q');
 const url = 'https://github.com/' + input.repository + '.git';
 git('-c','credential.helper=','fetch','--no-tags','--depth=1',url,input.baseSha);
 git('checkout','-q','--detach',input.baseSha);
 if(git('rev-parse','HEAD') !== input.baseSha || git('rev-parse','HEAD^{tree}') !== input.treeSha) throw Error('Pinned repository mismatch');
 fs.mkdirSync(path.join(root,'lfs'), {mode:0o700});
 for(const [index, source] of input.lfsSources.entries()) {
  const pointer = execFileSync('git',['-C',repo,'show',input.baseSha+':'+source.path],{env,stdio:['ignore','pipe','pipe']});
  const expected = 'version https://git-lfs.github.com/spec/v1\noid sha256:'+source.digest+'\nsize '+source.bytes+'\n';
  if(pointer.toString() !== expected) throw Error('LFS pointer identity mismatch');
  const output = path.join(root,'lfs',String(index));
  const fd = fs.openSync(output,'wx',0o600);
  let result;
  try {
   result = spawnSync('git',['-C',repo,'-c','credential.helper=','-c','lfs.url='+url+'/info/lfs','-c','lfs.skipdownloaderrors=false','-c','lfs.fetchinclude=','-c','lfs.fetchexclude=','lfs','smudge','--',source.path],{env:{...env,GIT_LFS_SKIP_SMUDGE:'0'},input:pointer,stdio:['pipe',fd,'pipe']});
  } finally { fs.closeSync(fd); }
  if(result.error || result.status !== 0) throw Error('Anonymous LFS acquisition unavailable');
  const hash = crypto.createHash('sha256'); let bytes=0;
  for await(const chunk of fs.createReadStream(output)){hash.update(chunk);bytes+=chunk.length;}
  if(hash.digest('hex')!==source.digest || bytes!==source.bytes) throw Error('LFS content mismatch');
 }
 for(const entry of ['config','hooks','logs','FETCH_HEAD','lfs']) fs.rmSync(path.join(repo,'.git',entry),{recursive:true,force:true});
 if(git('status','--porcelain','--untracked-files=all')) throw Error('Prepared repository is dirty');
})().catch(() => { console.error('Daytona repository readiness or anonymous Git/LFS preparation failed; no harness started'); process.exitCode=1; });
`;
