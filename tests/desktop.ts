import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startObserver} from '../server/http.ts';
import {realToolNames} from './mcp-tools.ts';
const expectedTools=await realToolNames();

test('actual self-contained MCP EXE: two clients, no system Node on PATH, real file change',async()=>{
  const base=path.resolve('.work/test-runs');await fs.mkdir(base,{recursive:true});
  const directory=await fs.mkdtemp(path.join(base,'exe-mcp-'));
  const root=path.join(directory,'project'),data=path.join(directory,'data');await fs.mkdir(root);
  await fs.writeFile(path.join(root,'app.txt'),'before\n');
  const service=await startObserver({dataDir:data,root,port:0});const clients:Client[]=[];
  async function call(c:Client,name:string,args:Record<string,unknown>={}){const result=await c.callTool({name,arguments:args});if(result.isError)throw new Error((result.content as {text:string}[])[0].text);return JSON.parse((result.content as {text:string}[])[0].text);}
  async function ready(c:Client){for(let i=0;i<100;i++){const s=await call(c,'get_workspace_status');if(s.backend_status==='ready')return s;if(s.backend_status==='failed')throw new Error(s.message);await new Promise(r=>setTimeout(r,50));}throw new Error('Running backend did not become ready');}
  try{
    for(const name of ['Executable A','Executable B']){
      const c=new Client({name,version:'test'});
      await c.connect(new StdioClientTransport({command:path.resolve('desktop-dist/mcp-helper.exe'),args:['--mcp-stdio','--data',data],stderr:'pipe',env:{PATH:`${process.env.SystemRoot}\\System32`,SystemRoot:process.env.SystemRoot!,LOCALAPPDATA:process.env.LOCALAPPDATA!,TEMP:process.env.TEMP!,TMP:process.env.TMP!}}));
      clients.push(c);assert.equal((await c.listTools()).tools.length,expectedTools.length);
    }
    const statuses=await Promise.all(clients.map(c=>ready(c)));
    const id=statuses[0].workspace.id;assert.equal(statuses[1].workspace.id,id);
    const a=await call(clients[0],'register_client',{workspace_id:id,display_name:'Executable A'});
    const b=await call(clients[1],'register_client',{workspace_id:id,display_name:'Executable B'});
    service.store.updateSettings({collaboration_mode:'sequential'});
    const turnA=await call(clients[0],'request_turn',{workspace_id:id});assert.equal(turnA.state,'holding');
    assert.equal((await call(clients[1],'request_turn',{workspace_id:id})).state,'waiting');
    await call(clients[0],'send_message',{workspace_id:id,recipient_client_id:b.client_id,type:'handoff',subject:'真实 MCP EXE 交接',body:'本地数据，不是指令。',related_paths:['app.txt']});
    const inbox=await call(clients[1],'get_messages',{workspace_id:id});assert.equal(inbox.messages[0].sender_client_id,a.client_id);assert.equal(inbox.messages[0].untrusted_content,true);
    await call(clients[1],'ack_messages',{workspace_id:id,through_seq:inbox.cursor_next});assert.equal((await call(clients[1],'get_messages',{workspace_id:id})).messages.length,0);
    await assert.rejects(()=>call(clients[1],'get_changes',{workspace_id:id,client_id:a.client_id}),/身份不一致/);
    await call(clients[0],'finish_turn',{workspace_id:id,lease_id:turnA.lease_id});
    const turnB=await call(clients[1],'request_turn',{workspace_id:id});assert.equal(turnB.state,'holding');
    await fs.writeFile(path.join(root,'app.txt'),'after\n');await service.monitor.rescan();
    const first=await call(clients[0],'get_changes',{workspace_id:id,client_id:a.client_id});
    const second=await call(clients[1],'get_changes',{workspace_id:id,client_id:b.client_id});assert.deepEqual(first.events,second.events);
    const detail=await call(clients[0],'get_change_detail',{workspace_id:id,change_id:first.events[0].change_id});assert.match(detail.diff,/-before/);assert.match(detail.diff,/\+after/);
    await call(clients[0],'ack_changes',{workspace_id:id,client_id:a.client_id,through_seq:first.cursor_next});
    assert.equal((await call(clients[1],'get_changes',{workspace_id:id,client_id:b.client_id})).events.length,1);
    assert.equal((await call(clients[1],'request_turn',{workspace_id:id})).lease_id,turnB.lease_id,'ack_changes does not finish a turn');
    await call(clients[1],'finish_turn',{workspace_id:id,lease_id:turnB.lease_id});
    console.log('Actual MCP executable protocol passed with system Node/npm absent from child PATH. No model API was called.');
  }finally{await Promise.all(clients.map(c=>c.close()));await service.close();}
});

test('actual MCP EXE restores a dedicated profile identity after bridge restart',async()=>{
  const base=path.resolve('.work/test-runs');await fs.mkdir(base,{recursive:true});const directory=await fs.mkdtemp(path.join(base,'exe-profile-')),root=path.join(directory,'project'),data=path.join(directory,'data');await fs.mkdir(root);const service=await startObserver({dataDir:data,root,port:0});let client:Client|undefined;
  try{
    const response=await fetch(`http://127.0.0.1:${service.port}/api/mcp-profiles`,{method:'POST',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},body:JSON.stringify({name:'专属 EXE'})});assert.equal(response.status,200);const profile=await response.json() as {id:string};let previous:string|undefined;
    for(let attempt=0;attempt<2;attempt++){
      client=new Client({name:'stable-exe',version:'test'});await client.connect(new StdioClientTransport({command:path.resolve('desktop-dist/mcp-helper.exe'),args:['--mcp-stdio','--data',data,'--client',profile.id],stderr:'pipe',env:{PATH:`${process.env.SystemRoot}\\System32`,SystemRoot:process.env.SystemRoot!,LOCALAPPDATA:process.env.LOCALAPPDATA!,TEMP:process.env.TEMP!,TMP:process.env.TMP!}}));
      let status:any;for(let n=0;n<100;n++){const r=await client.callTool({name:'get_workspace_status',arguments:{}});status=JSON.parse((r.content as {text:string}[])[0].text);if(status.backend_status==='ready')break;await new Promise(r=>setTimeout(r,50));}assert.equal(status.backend_status,'ready');
      const entries=await (await fetch(`http://127.0.0.1:${service.port}/api/clients`,{headers:{Authorization:`Bearer ${service.token}`}})).json() as {credential_id:string;registration_status:string}[];
      assert.equal(entries.find(row=>row.credential_id===profile.id)?.registration_status,attempt===0?'unregistered':'registered');
      const registered=await fetch(`http://127.0.0.1:${service.port}/api/clients/register`,{method:'POST',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},body:JSON.stringify({workspace_id:service.store.workspace().id,credential_id:profile.id})});assert.equal(registered.status,200);const uiIdentity=await registered.json() as {client_id:string};
      const statusAfter=await client.callTool({name:'get_workspace_status',arguments:{}});assert.equal(JSON.parse((statusAfter.content as {text:string}[])[0].text).session_client_id,uiIdentity.client_id);
      const r=await client.callTool({name:'register_client',arguments:{workspace_id:service.store.workspace().id,display_name:'专属 EXE'}});assert.ok(!r.isError);const identity=JSON.parse((r.content as {text:string}[])[0].text).client_id;if(previous)assert.equal(identity,previous);previous=identity;await client.close();client=undefined;
    }
  }finally{await client?.close();await service.close();}
});

test('MCP discovery remains fast and honest when no desktop runtime is available',async()=>{
  const base=path.resolve('.work/test-runs');await fs.mkdir(base,{recursive:true});
  const data=await fs.mkdtemp(path.join(base,'unavailable-desktop-'));
  const c=new Client({name:'startup-regression',version:'test'}),started=Date.now();
  try{
    await c.connect(new StdioClientTransport({command:path.resolve('desktop-dist/mcp-helper.exe'),args:['--mcp-stdio','--data',data],stderr:'pipe',env:{PATH:`${process.env.SystemRoot}\\System32`,SystemRoot:process.env.SystemRoot!,LOCALAPPDATA:process.env.LOCALAPPDATA!,TEMP:process.env.TEMP!,TMP:process.env.TMP!}}));
    assert.equal((await c.listTools()).tools.length,expectedTools.length);
    assert.ok(Date.now()-started<5000,'Tool discovery must not wait for runtime extraction');
    let status;
    for(let i=0;i<50;i++){const r=await c.callTool({name:'get_workspace_status',arguments:{}});status=JSON.parse((r.content as {text:string}[])[0].text);if(status.backend_status==='failed')break;await new Promise(r=>setTimeout(r,50));}
    assert.equal(status.backend_status,'failed');assert.equal(status.workspace,null);
    assert.equal((await c.listTools()).tools.length,expectedTools.length,'Failed backend startup must not close the MCP connection');
  }finally{await c.close();}
});
