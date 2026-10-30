import {runDesktopBridge} from './bridge-entry.ts';
import {readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
const args=process.argv.slice(1);
const at=args.indexOf('--data');
const dataDir=at>=0?path.resolve(args[at+1]):path.join(process.env.LOCALAPPDATA??path.join(os.homedir(),'AppData','Local'),'TongpinObserver','data');
if(args.includes('--self-test')){
  process.stdout.write(JSON.stringify({name:'Tongpin MCP',version:'0.2.2',node:process.versions.node,self_contained:true})+'\n');
}else{
  runDesktopBridge(dataDir,()=>{
    let launcher:string|undefined;
    try{launcher=JSON.parse(readFileSync(path.join(dataDir,'desktop-app.json'),'utf8')).launcher;}catch{}
    if(!launcher||!existsSync(launcher))launcher=path.join(path.dirname(process.execPath),'tongpin-desktop.exe');
    if(!existsSync(launcher))throw new Error('请先双击同频 EXE；或者安装含桌面程序的完整 MCP 接入包。');
    const child=spawn(launcher,['--background','--data',dataDir],{windowsHide:true,detached:true,stdio:'ignore'});
    child.on('error',()=>console.error('无法启动同频桌面运行时。请先双击同频 EXE。'));child.unref();
  },()=>process.exit(0),args.includes('--client')?args[args.indexOf('--client')+1]:undefined).catch(e=>{console.error(e.message);process.exit(1);});
}
