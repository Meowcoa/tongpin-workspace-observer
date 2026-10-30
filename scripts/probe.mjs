import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const index=process.argv.indexOf('--data');
const data=index<0?path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.observer-data'):path.resolve(process.argv[index+1]);
const {url}=JSON.parse(await readFile(path.join(data,'connection.json'),'utf8'));
const bootstrap=(await readFile(path.join(data,'mcp.key'),'utf8')).trim();
if(new URL(url).hostname!=='127.0.0.1'||new URL(url).protocol!=='http:'||new URL(url).pathname!=='/mcp')throw new Error('Only local service endpoints are allowed');
const clients=[];
async function call(c,name,args={}){const r=await c.callTool({name,arguments:args});if(r.isError)throw new Error(r.content[0].text);return JSON.parse(r.content[0].text);}
try{
  for(const name of ['SDK 客户端 A（验证）','SDK 客户端 B（验证）']){
    const session=await fetch(new URL('/bridge/session',url),{method:'POST',headers:{Authorization:`Bearer ${bootstrap}`},signal:AbortSignal.timeout(5000)});if(!session.ok)throw new Error('Cannot create independent test identity');const {token}=await session.json();
    const c=new Client({name,version:'0.2.0'});await c.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));clients.push(c);
  }
  const [a,b]=clients;const {workspace}=await call(a,'get_workspace_status');
  if(!workspace)throw new Error('请先在界面选择监控文件夹');
  const ra=await call(a,'register_client',{workspace_id:workspace.id,display_name:'SDK 客户端 A（验证）'});
  const rb=await call(b,'register_client',{workspace_id:workspace.id,display_name:'SDK 客户端 B（验证）'});
  const aa={workspace_id:workspace.id,client_id:ra.client_id};const bb={workspace_id:workspace.id,client_id:rb.client_id};
  const ea=await call(a,'get_changes',{...aa,after_seq:0});const eb=await call(b,'get_changes',{...bb,after_seq:0});
  if(ea.history_gap)throw new Error('历史已清理；请在没有历史缺口的试用工作区运行协议验证');
  assert.deepEqual(ea.events,eb.events);
  await call(a,'ack_changes',{...aa,through_seq:ea.cursor_next});
  assert.deepEqual((await call(b,'get_changes',{...bb,after_seq:0})).events,eb.events);
  const textEvent=ea.events.find(x=>/\.(?:ts|txt|md|json)$/.test(x.path));
  if(textEvent){const detail=await call(a,'get_change_detail',{workspace_id:workspace.id,change_id:textEvent.change_id});assert.ok(detail.diff || detail.unavailable_reason);}
  await call(a,'report_activity',{...aa,summary:'协议联调（没有调用模型）',paths:[],ttl_seconds:300});
  await call(b,'report_activity',{...bb,summary:'验证独立未读位置（没有调用模型）',paths:[],ttl_seconds:300});
  console.log(`协议验证通过：两个独立 MCP 客户端均获取 ${ea.events.length} 条真实事件，A 确认至 #${ea.cursor_next}，B 的未读记录保持不变。`);
  console.log('这是 SDK 协议验证，不表示 Codex、Claude 或 Gemini 的模型会话联调通过。');
}finally{await Promise.all(clients.map(c=>c.close()));}
