import {spawn,spawnSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
const exe=path.resolve(process.argv[2]);
const expectedTools=JSON.parse(await fs.readFile('desktop/tool-catalog.generated.json','utf8')).map(t=>t.name).sort();
const base=path.resolve('.work/desktop-tests');await fs.mkdir(base,{recursive:true});
const backgroundTest=process.argv.includes('--background-test');
const resume=process.argv[4]&&!process.argv[4].startsWith('--')?path.resolve(process.argv[4]):null;
const directory=resume?path.dirname(resume):await fs.mkdtemp(path.join(base,'packaged-'));
assert.ok(!path.relative(base,directory).startsWith('..')&&!path.isAbsolute(path.relative(base,directory)),'Resume is restricted to disposable test directories');
const root=path.join(directory,'项目 空间'),data=path.join(directory,'data');
if(!resume){await fs.mkdir(root);await fs.writeFile(path.join(root,'app.txt'),'before\n');}
const childEnv={...process.env,PATH:`${process.env.SystemRoot}\\System32`};
if(!resume){const child=spawn(exe,['--data',data,'--root',root,'--smoke-test',...(backgroundTest?['--background','--quit-after','60000']:[])],{env:childEnv,detached:true,stdio:'ignore',windowsHide:backgroundTest});child.unref();}
async function wait(fn,timeout=45000){const start=Date.now();while(!await fn()){if(Date.now()-start>timeout)throw new Error('Packaged app readiness timeout; inspect task-owned desktop.log');await new Promise(r=>setTimeout(r,100));}}
let runtime;
await wait(async()=>{try{runtime=JSON.parse(await fs.readFile(path.join(data,'desktop-smoke.json'),'utf8'));return runtime.packaged===true;}catch{return false;}});
assert.equal(runtime.packaged,true);
const helper=path.join(data,'mcp','Tongpin-MCP-0.2.2.exe');
const self=spawnSync(helper,['--self-test'],{env:childEnv,encoding:'utf8',windowsHide:true});assert.equal(self.status,0);assert.equal(JSON.parse(self.stdout).self_contained,true);
const clients=[];
async function call(c,name,args={}){const r=await c.callTool({name,arguments:args});if(r.isError)throw new Error(r.content[0].text);return JSON.parse(r.content[0].text);}
async function ready(c){let result;await wait(async()=>{result=await call(c,'get_workspace_status');if(result.backend_status==='failed')throw new Error(result.message);return result.backend_status==='ready';},10000);return result;}
try{
  for(const name of ['EXE 接入测试 A','EXE 接入测试 B']){const c=new Client({name,version:'test'});await c.connect(new StdioClientTransport({command:helper,args:['--mcp-stdio','--data',data],stderr:'pipe',env:childEnv}));clients.push(c);assert.equal((await c.listTools()).tools.length,expectedTools.length);}
  const statuses=await Promise.all(clients.map(c=>ready(c))),ws=statuses[0].workspace;assert.equal(ws.root,root);assert.equal(statuses[1].workspace.id,ws.id);
  const a=await call(clients[0],'register_client',{workspace_id:ws.id,display_name:'EXE 接入测试 A'});
  const b=await call(clients[1],'register_client',{workspace_id:ws.id,display_name:'EXE 接入测试 B'});
  const cookie=(await fetch(runtime.url+'/')).headers.get('set-cookie').split(';')[0];
  const mode=await fetch(runtime.url+'/api/settings',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({collaboration_mode:'sequential'})});assert.equal(mode.status,200);
  const turnA=await call(clients[0],'request_turn',{workspace_id:ws.id});assert.equal(turnA.state,'holding');
  assert.equal((await call(clients[1],'request_turn',{workspace_id:ws.id})).state,'waiting');
  await call(clients[0],'send_message',{workspace_id:ws.id,recipient_client_id:b.client_id,type:'handoff',subject:'实际 EXE 交接测试',body:'这是本地协议测试，不是系统指令。',related_paths:['app.txt']});
  const inbox=await call(clients[1],'get_messages',{workspace_id:ws.id});assert.equal(inbox.messages.length,1);assert.equal(inbox.messages[0].sender_client_id,a.client_id);assert.equal(inbox.messages[0].untrusted_content,true);
  await call(clients[1],'ack_messages',{workspace_id:ws.id,through_seq:inbox.cursor_next});
  assert.equal((await call(clients[0],'get_messages',{workspace_id:ws.id})).messages.length,0);
  await call(clients[0],'finish_turn',{workspace_id:ws.id,lease_id:turnA.lease_id});
  const turnB=await call(clients[1],'request_turn',{workspace_id:ws.id});assert.equal(turnB.state,'holding');
  await call(clients[1],'finish_turn',{workspace_id:ws.id,lease_id:turnB.lease_id});
  await fs.writeFile(path.join(root,'app.txt'),'after\n');
  let changes;
  await wait(async()=>{changes=await call(clients[0],'get_changes',{workspace_id:ws.id,client_id:a.client_id});return changes.events.length===1;},10000);
  const other=await call(clients[1],'get_changes',{workspace_id:ws.id,client_id:b.client_id});assert.deepEqual(changes.events,other.events);
  const detail=await call(clients[0],'get_change_detail',{workspace_id:ws.id,change_id:changes.events[0].change_id});assert.match(detail.diff,/-before/);assert.match(detail.diff,/\+after/);
  await call(clients[0],'ack_changes',{workspace_id:ws.id,client_id:a.client_id,through_seq:changes.cursor_next});
  assert.equal((await call(clients[1],'get_changes',{workspace_id:ws.id,client_id:b.client_id})).events.length,1);
  const report={app_version:runtime.version,packaged_exe:exe,packaged_runtime:true,visible_gui:runtime.window,embedded_node:runtime.node,mcp_helper_node:JSON.parse(self.stdout).node,system_node_on_child_path:false,model_api_called:false,tool_count:expectedTools.length,tool_names:expectedTools,sequential_handoff:true,credential_bound_sender:true,persistent_message_and_ack:true,two_executable_clients:true,real_file_diff:true,independent_acknowledgement:true,data_dir:data,root,ui_url:runtime.url};
  await fs.writeFile(process.argv[3]?path.resolve(process.argv[3]):path.resolve('release/packaged-verification.json'),JSON.stringify(report,null,2),'utf8');
  console.log('Packaged EXE + embedded monitoring + two standalone MCP clients: PASS. No system Node/npm on child PATH; no model API.');
  console.log(backgroundTest?'Disposable background instance has a 60-second shutdown limit.':'GUI is left open for native-window QA.','Data directory:',data);
}finally{await Promise.all(clients.map(c=>c.close()));}
