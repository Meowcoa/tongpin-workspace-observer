import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const {version}=JSON.parse(await readFile('package.json','utf8'));
const exe=path.resolve('release',`Tongpin-${version}-windows-x64.exe`);
const result=spawnSync(process.execPath,['scripts/verify-packaged.mjs',exe,path.resolve('release','packaged-verification.json'),'--background-test'],{stdio:'inherit',windowsHide:true});
if(result.status!==0)throw new Error('Built application verification failed');
