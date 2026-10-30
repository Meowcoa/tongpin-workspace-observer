import {promises as fs} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const result=spawnSync('git',['ls-files','--cached','-z'],{cwd:root,encoding:'utf8',windowsHide:true});
if(result.status!==0)throw new Error('Run source checks in a Git checkout');
const files=result.stdout.split('\0').filter(Boolean);if(!files.length)throw new Error('No tracked source files to check');
const bad=[];
for(const file of files){
  if(/(^|\/)(node_modules|dist|desktop-dist|release|\.work|\.observer-data)(\/|$)|\.(exe|mcpb|zip|7z|sqlite(?:-.*)?|db(?:-.*)?|key|pem|p12|pfx)$|(^|\/)\.env(?:\.|$)/i.test(file)&&!file.endsWith('.env.example')){bad.push({file,reason:'generated or private file'});continue;}
  const absolute=path.join(root,file),stat=await fs.lstat(absolute);
  if(stat.isSymbolicLink()||stat.size>2*1024*1024){bad.push({file,reason:'symlink or oversized source artifact'});continue;}
  if(/\.(png|ico)$/i.test(file))continue;
  const text=new TextDecoder('utf-8',{fatal:true}).decode(await fs.readFile(absolute));
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{24,}/.test(text))bad.push({file,reason:'credential-like content'});
  if(/[A-Z]:[\\/]+Users[\\/]|\/(?:Users|home)\/[^\s/'"]+/i.test(text))bad.push({file,reason:'personal absolute path'});
  if(/\.\.\/\.\.\/work\//.test(text))bad.push({file,reason:'output outside the checkout'});
}
const ignored=['.observer-data/access.key','.work/test-runs/db.sqlite','release/Tongpin.exe','desktop-dist/mcp-helper.exe','node_modules/example/file.js'];
const ignore=spawnSync('git',['check-ignore','--stdin'],{cwd:root,input:ignored.join('\n')+'\n',encoding:'utf8',windowsHide:true});
if(ignore.status!==0||ignore.stdout.trim().split(/\r?\n/).length!==ignored.length)bad.push({file:'.gitignore',reason:'required runtime ignores missing'});
if(bad.length){for(const issue of bad)console.error(`${issue.file}: ${issue.reason}`);process.exitCode=1;}else console.log(`Tracked-source check passed: ${files.length} files; no generated/private artifacts or personal paths.`);
