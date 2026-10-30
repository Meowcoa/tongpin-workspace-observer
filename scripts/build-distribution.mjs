import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),{pluginArchive}=require('../desktop/export.cjs'),{unzipSync}=require('fflate');
const {version}=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const directory=path.join(root,'release','distribution');await fs.mkdir(directory,{recursive:true});
const name=`Tongpin-${version}-windows-x64.exe`,exe=path.join(root,'release',name),mcp=path.join(root,'desktop-dist','mcp-helper.exe');
await fs.copyFile(exe,path.join(directory,name));
for(const [format,file] of [['mcpb',`Tongpin-MCP-${version}.mcpb`],['codex',`Tongpin-Codex-${version}.zip`]]){
  // Public packages use each user's default data directory, never a maintainer's absolute path or profile.
  const bytes=await pluginArchive(exe,format,mcp),files=unzipSync(bytes);
  const manifest=JSON.parse(new TextDecoder().decode(files[format==='mcpb'?'manifest.json':'mcp.json']));
  assert.deepEqual(format==='mcpb'?manifest.server.mcp_config.args:manifest.mcpServers.workspace_observer.args,['--mcp-stdio']);
  assert.ok(files.LICENSE&&files['THIRD_PARTY_LICENSES.txt']);
  assert.ok(!Object.keys(files).some(p=>/\.key$|workspace\.sqlite|client-credentials/.test(p)));
  await fs.writeFile(path.join(directory,file),bytes);
}
for(const [source,target] of [['LICENSE','LICENSE'],['THIRD_PARTY_NOTICES.md','THIRD_PARTY_NOTICES.md'],['release/THIRD_PARTY_LICENSES.txt','THIRD_PARTY_LICENSES.txt']])await fs.copyFile(path.join(root,source),path.join(directory,target));
await fs.writeFile(path.join(directory,'README.zh-CN.txt'),`同频 ${version}\n\n双击 ${name} 运行。无需安装 Node.js 或另外启动服务器。\n项目：https://github.com/Meowcoa/tongpin-workspace-observer\n\n在同频中选择项目，各 AI 打开同一目录。到“连接 MCP”为各 AI 生成专属配置，实际连接后可在“AI 客户端”一键登记。\n公开 MCP 接入包使用每个 Windows 用户自己的默认数据目录，不含开发者目录或凭据；需要稳定身份时从本机程序导出专属包。\n回合不是文件锁，消息不会自动唤醒 AI。关闭窗口留在托盘，退出请用托盘菜单。\n`,'utf8');
const names=(await fs.readdir(directory)).filter(n=>n!=='SHA256SUMS.txt').sort(),sums=[];
for(const file of names){const bytes=await fs.readFile(path.join(directory,file));sums.push(createHash('sha256').update(bytes).digest('hex')+'  '+file);}
await fs.writeFile(path.join(directory,'SHA256SUMS.txt'),sums.join('\n')+'\n','utf8');
console.log(`Public Windows distribution ready: ${directory}`);
