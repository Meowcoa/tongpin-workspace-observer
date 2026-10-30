import {promises as fs} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {unzipSync} from 'fflate';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const {version}=JSON.parse(await fs.readFile('package.json','utf8'));
const base=path.resolve('.work','public-bundle-tests');await fs.mkdir(base,{recursive:true});
const directory=await fs.mkdtemp(path.join(base,'bundle-')),server=path.join(directory,'server'),localData=path.join(directory,'local-user');await fs.mkdir(server);
const files=unzipSync(new Uint8Array(await fs.readFile(path.join('release','distribution',`Tongpin-MCP-${version}.mcpb`))),{filter:f=>f.name.startsWith('server/')});
for(const name of ['tongpin-mcp.exe','tongpin-desktop.exe'])await fs.writeFile(path.join(server,name),files['server/'+name]);
const expectedData=path.join(localData,'TongpinObserver','data'),env={...process.env,LOCALAPPDATA:localData,PATH:path.join(process.env.SystemRoot,'System32')};
const client=new Client({name:'public-bundle-verification',version:'test'}),started=Date.now();
try{
  await client.connect(new StdioClientTransport({command:path.join(server,'tongpin-mcp.exe'),args:['--mcp-stdio'],env,stderr:'pipe'}));
  const tools=await client.listTools(),discovery=Date.now()-started;assert.ok(tools.tools.length>0);assert.ok(discovery<5000,'Discovery must not wait for portable extraction');
  let status;for(let n=0;n<480;n++){const r=await client.callTool({name:'get_workspace_status',arguments:{}});status=JSON.parse(r.content[0].text);if(status.backend_status==='failed')throw new Error(status.message);if(status.backend_status==='ready')break;await new Promise(r=>setTimeout(r,250));}
  assert.equal(status.backend_status,'ready');assert.equal(status.workspace,null,'A clean user must not inherit a maintainer workspace');
  assert.ok(JSON.parse(await fs.readFile(path.join(expectedData,'connection.json'),'utf8')).pid);
  await fs.writeFile(path.join('release','public-bundle-verification.json'),JSON.stringify({version,public_default_arguments:true,isolated_user_data:true,workspace:null,discovery_ms:discovery,ready_ms:Date.now()-started,tool_count:tools.tools.length,system_node_on_child_path:false},null,2),'utf8');
  console.log('Public MCP bundle cold start with isolated LOCALAPPDATA and no system Node/npm: PASS.');
}finally{
  await client.close();
  try{await fs.access(path.join(expectedData,'connection.json'));const stop=spawn(path.join(server,'tongpin-desktop.exe'),['--shutdown','--data',expectedData],{env,stdio:'ignore',windowsHide:true});await new Promise((resolve,reject)=>{stop.once('error',reject);stop.once('exit',code=>code===0?resolve():reject(new Error('Public bundle cleanup failed')));});}catch(e){if(e.code!=='ENOENT')throw e;}
}
