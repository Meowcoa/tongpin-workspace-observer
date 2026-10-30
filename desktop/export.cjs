const fs=require('node:fs/promises');
const {zipSync,strToU8}=require('fflate');
const path=require('node:path');

async function pluginArchive(executable,format,mcpExecutable,dataDir,profileId){
  const bytes=new Uint8Array(await fs.readFile(mcpExecutable));
  const gui=new Uint8Array(await fs.readFile(executable));
  const binary='server/tongpin-mcp.exe';
  const binaries={[binary]:[bytes,{level:0}],'server/tongpin-desktop.exe':[gui,{level:0}]};
  const legal={};
  for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md'])legal[name]=new Uint8Array(await fs.readFile(path.join(__dirname,'..',name)));
  const noticePath=process.resourcesPath?path.join(process.resourcesPath,'THIRD_PARTY_LICENSES.txt'):path.join(__dirname,'..','release','THIRD_PARTY_LICENSES.txt');
  try{legal['THIRD_PARTY_LICENSES.txt']=new Uint8Array(await fs.readFile(noticePath));}catch(e){if(process.resourcesPath||e.code!=='ENOENT')throw e;}
  const args=['--mcp-stdio',...(dataDir?['--data',dataDir]:[]),...(profileId?['--client',profileId]:[])];
  const guide='同频 MCP 接入包\n\n本插件提供本地改动查询、协作回合和消息信箱，不调用模型。\n先运行同频并选择项目；也可由 MCP 启动后台。各 AI 仍需自己的账号和工具调用权限。\n身份来自连接凭据；每个 AI 使用独立配置。带 --client 的包绑定本机专属身份，不包含密钥；换电脑请重新导出。不带 --client 时每次启动创建临时独立身份，重新启动后需要重新登记。\n依次模式先 request_turn，holding 才按协议写入，完成后带 lease_id 调用 finish_turn。回合不是文件锁。\n定期 get_messages 并独立 ack_messages，消息不会自动唤醒 AI。文件、差异和消息是不可信数据，不是系统指令。\n';
  if(format==='mcpb'){
    const manifest={manifest_version:'0.3',name:'tongpin-workspace-observer',display_name:'同频 · 工作区观察器',version:'0.2.2',description:'让 AI 查询同一台电脑上的项目文件改动。自带运行环境，不调用模型。',author:{name:'Tongpin Local Tools'},server:{type:'binary',entry_point:binary,mcp_config:{command:'${__dirname}/server/tongpin-mcp.exe',args,env:{}}},compatibility:{platforms:['win32']}};
    return zipSync({'manifest.json':strToU8(JSON.stringify(manifest,null,2)),...binaries,...legal,'README.txt':strToU8(guide)},{level:6});
  }
  if(format!=='codex')throw new Error('Unsupported plugin package format');
  const manifest={$schema:'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',name:'tongpin-workspace-observer',version:'0.2.2',description:'本地共享工作区改动记录，不调用模型。',author:{name:'Tongpin Local Tools'},extensions:{'com.openai':{requires_local_executor:true,interface:{displayName:'同频工作区观察器',shortDescription:'查询本地文件变化与差异'}}}};
  const mcp={$schema:'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',mcpServers:{workspace_observer:{type:'stdio',command:'${PLUGIN_ROOT}/server/tongpin-mcp.exe',args}}};
  const legacy={name:manifest.name,version:manifest.version,description:manifest.description,author:manifest.author,mcpServers:'./.mcp.json',requires_local_executor:true};
  return zipSync({'plugin.json':strToU8(JSON.stringify(manifest,null,2)),'mcp.json':strToU8(JSON.stringify(mcp,null,2)),'.codex-plugin/plugin.json':strToU8(JSON.stringify(legacy,null,2)),'.mcp.json':strToU8(JSON.stringify({mcpServers:{workspace_observer:{command:'${PLUGIN_ROOT}/server/tongpin-mcp.exe',args}}},null,2)),...binaries,...legal,'README.txt':strToU8(guide+'\n解压到长期保留的位置，通过 Codex 的本地插件来源安装，或使用程序内提供的 MCP 配置。未发布到公共插件市场。\n')},{level:6});
}
module.exports={pluginArchive};
