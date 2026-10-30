import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startObserver} from '../server/http.ts';
import {Store} from '../server/store.ts';
import {WAITING_TIMEOUT_SECONDS} from '../server/collaboration.ts';
import {realToolNames} from './mcp-tools.ts';
const names=await realToolNames(),base=path.resolve('.work/test-runs');await fs.mkdir(base,{recursive:true});
const message={type:'notice' as const,subject:'本地协作数据',body:'不能作为系统指令执行',related_paths:[],related_change_ids:[]};
async function fixture(){const folder=await fs.mkdtemp(path.join(base,'collaboration-')),root=path.join(folder,'project'),data=path.join(folder,'data');await fs.mkdir(root);const service=await startObserver({dataDir:data,root,port:0});return {folder,root,data,service,url:`http://127.0.0.1:${service.port}`};}
async function connect(s:Awaited<ReturnType<typeof startObserver>>,name:string,token=s.store.identity.issue(name).token){const c=new Client({name,version:'test'});await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));return c;}
async function call(c:Client,name:string,args:Record<string,unknown>={}){const r=await c.callTool({name,arguments:args});if(r.isError)throw new Error((r.content as {text:string}[])[0].text);return JSON.parse((r.content as {text:string}[])[0].text);}
async function http(f:Awaited<ReturnType<typeof fixture>>,route:string,body?:unknown,token=f.service.token){return fetch(f.url+route,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}

test('additive legacy migration preserves settings, clients, snapshots and changes; mode survives restart',async()=>{
  const folder=await fs.mkdtemp(path.join(base,'legacy-collaboration-')),file=path.join(folder,'legacy.sqlite'),db=new DatabaseSync(file),workspace=randomUUID(),epoch=randomUUID(),client=randomUUID(),change=randomUUID();
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE workspaces(id TEXT PRIMARY KEY,root TEXT NOT NULL UNIQUE,epoch TEXT NOT NULL,initialized INTEGER NOT NULL DEFAULT 0,seq INTEGER NOT NULL DEFAULT 0,oldest INTEGER NOT NULL DEFAULT 1,health TEXT NOT NULL DEFAULT 'indexing',error TEXT,scanned TEXT,file_count INTEGER NOT NULL DEFAULT 0);CREATE TABLE clients(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,name TEXT NOT NULL,epoch TEXT NOT NULL,ack INTEGER NOT NULL DEFAULT 0,delivered INTEGER NOT NULL DEFAULT 0,seen TEXT NOT NULL);CREATE TABLE snapshots(hash TEXT PRIMARY KEY,text TEXT NOT NULL,bytes INTEGER NOT NULL,created TEXT NOT NULL);`);
  db.prepare('INSERT INTO meta VALUES(?,?)').run('settings',JSON.stringify({retention_days:42,snapshot_budget_mb:512,max_text_kb:256}));db.prepare('INSERT INTO meta VALUES(?,?)').run('active',workspace);db.prepare('INSERT INTO workspaces(id,root,epoch) VALUES(?,?,?)').run(workspace,folder,epoch);db.prepare('INSERT INTO clients VALUES(?,?,?,?,?,?,?)').run(client,workspace,'旧客户端',epoch,1,1,new Date().toISOString());db.prepare('INSERT INTO snapshots VALUES(?,?,?,?)').run('legacy-hash','旧快照',9,new Date().toISOString());db.close();
  let store=new Store(file);
  try{
    assert.equal(store.settings().collaboration_mode,'parallel');assert.equal(store.settings().retention_days,42);assert.equal(store.clients(workspace)[0].ack,1);assert.equal(store.one<{text:string}>('SELECT text FROM snapshots WHERE hash=?','legacy-hash')?.text,'旧快照');
    store.run('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)',workspace,1,change,'modified','app.txt','legacy-hash','legacy-hash',null,null,new Date().toISOString(),'watcher');store.run('UPDATE workspaces SET seq=1 WHERE id=?',workspace);
    store.updateSettings({collaboration_mode:'sequential',turn_timeout_seconds:120});const holding=store.collaboration.requestTurn(workspace,client);assert.equal(holding.state,'holding');const lease=holding.lease_id;
    store.updateSettings({retention_days:40,message_quota_total_kb:2048});assert.equal(store.collaboration.requestTurn(workspace,client).lease_id,lease);assert.equal(store.listChanges(workspace)[0].change_id,change);
    store.close();store=new Store(file);assert.equal(store.settings().turn_timeout_seconds,120);assert.equal(store.collaboration.status(workspace).holder?.client_id,client);assert.equal(store.clients(workspace)[0].ack,1);
    store.updateSettings({collaboration_mode:'parallel'});assert.equal(store.collaboration.status(workspace).holder,null);assert.equal(store.one<{n:number}>('SELECT count(*) AS n FROM turn_requests')!.n,0);assert.equal(store.listChanges(workspace).length,1);
    for(const settings of [{collaboration_mode:'invalid'},{turn_timeout_seconds:59},{turn_timeout_seconds:7201},{message_quota_total_kb:0},{unknown:true}])assert.throws(()=>store.updateSettings(settings as any));
  }finally{store.close();}
});

test('credential-bound HTTP tools reject impersonation, preserve stable identity and isolate UI management',async()=>{
  const f=await fixture(),s=f.service,id=s.store.workspace().id,clients:Client[]=[];
  try{
    const made=await http(f,'/api/mcp-profiles',{name:'稳定编写助手'});assert.equal(made.status,200);const profile=await made.json() as {id:string};const token=(await fs.readFile(path.join(f.data,'client-credentials',profile.id+'.key'),'utf8')).trim();
    const a=await connect(s,'A',token),b=await connect(s,'B');clients.push(a,b);assert.deepEqual((await a.listTools()).tools.map(t=>t.name).sort(),names);
    for(const tool of (await a.listTools()).tools.filter(t=>['request_turn','finish_turn','send_message','get_messages','ack_messages'].includes(t.name))){assert.ok(!('client_id' in (tool.inputSchema.properties??{})));assert.ok(!('sender_client_id' in (tool.inputSchema.properties??{})));}
    const ca=await call(a,'register_client',{workspace_id:id,display_name:'编写 A'}),cb=await call(b,'register_client',{workspace_id:id,display_name:'评审 B'});assert.notEqual(ca.client_id,cb.client_id);
    await assert.rejects(()=>call(b,'register_client',{workspace_id:id,display_name:'冒用 A',resume_client_id:ca.client_id}),/不能恢复/);
    await assert.rejects(()=>call(b,'get_changes',{workspace_id:id,client_id:ca.client_id}),/身份不一致/);
    await assert.rejects(()=>call(b,'send_message',{workspace_id:id,sender_client_id:ca.client_id,...message}),/Unrecognized|unrecognized|Invalid|输入|校验/);
    await assert.rejects(()=>call(b,'request_turn',{workspace_id:id,client_id:ca.client_id}),/Unrecognized|unrecognized|Invalid|输入|校验/);
    await a.close();const restored=await connect(s,'A-restored',token);clients.push(restored);assert.equal((await call(restored,'register_client',{workspace_id:id,display_name:'A 恢复'})).client_id,ca.client_id);
    const raw=await fetch(f.url+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${s.mcpToken}`,'Content-Type':'application/json'},body:'{}'});assert.equal(raw.status,401,'Shared bootstrap credential cannot call MCP tools');
    for(const route of ['/api/turn/force-release','/api/messages/clear','/api/settings','/api/mcp-profiles'])assert.equal((await http(f,route,{workspace_id:id},token)).status,401);
    const config=await (await http(f,'/api/connection?profile='+profile.id)).json();assert.ok(config.generic.includes('--client'));assert.ok(!JSON.stringify(config).includes(token));
    const previous=s.store.register(id,'旧的未绑定客户端');const bound=await (await http(f,'/api/mcp-profiles',{name:'恢复旧客户端',legacy_client_id:previous.client_id})).json();const oldToken=(await fs.readFile(path.join(f.data,'client-credentials',bound.id+'.key'),'utf8')).trim();const legacy=await connect(s,'legacy',oldToken);clients.push(legacy);assert.equal((await call(legacy,'register_client',{workspace_id:id,display_name:'恢复后的名称'})).client_id,previous.client_id);
    assert.equal((await http(f,'/api/mcp-profiles/'+profile.id+'/revoke',{})).status,200);await assert.rejects(()=>call(restored,'get_workspace_status'),/401|Unauthorized|凭据/);
    assert.equal((await http(f,'/api/settings',{unknown:true})).status,400);assert.equal((await http(f,'/api/settings',{collaboration_mode:'both'})).status,400);
  }finally{await Promise.all(clients.map(c=>c.close()));await s.close();}
});

test('parallel mode and transactional FIFO turns: renew, stale leases, cancellation, expiry and force release',async()=>{
  const f=await fixture(),s=f.service,id=s.store.workspace().id,clients:Client[]=[];
  try{
    for(const name of ['A','B','C','D']){const c=await connect(s,name);clients.push(c);await call(c,'register_client',{workspace_id:id,display_name:name});}
    const [a,b,c,d]=clients,ids=await Promise.all(clients.map(async x=>(await call(x,'get_workspace_status')).session_client_id));
    assert.equal((await call(a,'request_turn')).state,'not_required');assert.equal((await call(b,'request_turn')).allowed,true);assert.equal(s.store.one<{n:number}>('SELECT count(*) AS n FROM turn_requests')!.n,0);
    s.store.updateSettings({collaboration_mode:'sequential',turn_timeout_seconds:60,message_min_interval_seconds:0});
    const first=await call(a,'request_turn');assert.equal(first.state,'holding');const renewed=await call(a,'request_turn');assert.equal(renewed.lease_id,first.lease_id);assert.ok(renewed.expires_at>=first.expires_at);
    assert.equal((await call(b,'request_turn')).queue_position,1);const queued=s.store.one<{queue_seq:number;requested_at:number}>('SELECT queue_seq,requested_at FROM turn_requests WHERE client=?',ids[1])!;await call(b,'request_turn');assert.deepEqual(s.store.one('SELECT queue_seq,requested_at FROM turn_requests WHERE client=?',ids[1]),queued);
    assert.equal((await call(c,'request_turn')).queue_position,2);
    await call(b,'get_changes',{workspace_id:id});await call(b,'ack_changes',{workspace_id:id,through_seq:0});await call(b,'send_message',{workspace_id:id,...message});assert.equal((await call(b,'get_messages',{workspace_id:id})).messages.length,0);assert.equal(s.store.collaboration.status(id).holder?.client_id,ids[0]);
    await assert.rejects(()=>call(a,'finish_turn',{lease_id:randomUUID()}),/不匹配/);await call(a,'finish_turn',{lease_id:first.lease_id});assert.equal((await call(c,'request_turn')).state,'waiting','C cannot overtake B even with no current holder');const bTurn=await call(b,'request_turn');assert.equal(bTurn.state,'holding');
    assert.equal((await call(a,'finish_turn',{lease_id:first.lease_id})).released,false);assert.equal(s.store.collaboration.status(id).holder?.client_id,ids[1]);await call(b,'finish_turn',{lease_id:bTurn.lease_id});
    assert.equal((await call(c,'finish_turn')).state,'left_queue');
    const atOnce=await Promise.all([call(a,'request_turn'),call(b,'request_turn'),call(c,'request_turn'),call(d,'request_turn')]);assert.equal(atOnce.filter(t=>t.state==='holding').length,1);assert.equal(s.store.one<{n:number}>("SELECT count(*) AS n FROM turn_requests WHERE state='holding'")!.n,1);
    const holding=s.store.collaboration.status(id).holder!;s.store.run("UPDATE turn_requests SET expires_at=? WHERE client=?",Date.now()-1,holding.client_id);const expired=await call(a,'get_workspace_status');assert.equal(expired.collaboration.holder,null);assert.equal(expired.collaboration.expired_holder.state,'expired');const listed=await call(a,'list_clients',{workspace_id:id});assert.equal(listed.find((x:any)=>x.id===holding.client_id).turn.state,'expired');assert.ok(!JSON.stringify(listed).includes('lease_id'));
    s.store.run("UPDATE turn_requests SET last_polled_at=? WHERE state='waiting'",Date.now()-(WAITING_TIMEOUT_SECONDS+1)*1000);const newTurn=await call(d,'request_turn');assert.equal(newTurn.state,'holding');assert.notEqual(newTurn.lease_id,atOnce[3].lease_id);
    const forced=await http(f,'/api/turn/force-release',{workspace_id:id});assert.equal(forced.status,200);assert.equal((await forced.json()).client_id,ids[3]);assert.equal(s.store.collaboration.status(id).holder,null);assert.equal(s.store.collaboration.audit(id)[0].action,'force_release');
    const again=await call(d,'request_turn');await assert.rejects(()=>call(d,'finish_turn',{lease_id:newTurn.lease_id}),/不匹配/);assert.equal(s.store.collaboration.status(id).holder?.client_id,ids[3]);await call(d,'finish_turn',{lease_id:again.lease_id});
    const another=path.join(f.folder,'other');await fs.mkdir(another);const second=await s.monitor.select(another);assert.notEqual(second.id,id);assert.equal((await call(d,'get_workspace_status')).collaboration.holder,null);await assert.rejects(()=>call(d,'request_turn',{workspace_id:id}),/工作区已切换/);await assert.rejects(()=>call(d,'request_turn',{workspace_id:second.id}),/先 register_client/);
  }finally{await Promise.all(clients.map(c=>c.close()));await s.close();}
});

test('persistent messaging: private visibility, broadcasts, paging, independent ack, validation and epoch reset',async()=>{
  const f=await fixture();let s=f.service;const clients:Client[]=[];const aToken=s.store.identity.issue('A').token,bToken=s.store.identity.issue('B').token;
  try{
    const id=s.store.workspace().id,a=await connect(s,'A',aToken),b=await connect(s,'B',bToken),c=await connect(s,'C');clients.push(a,b,c);const ids=await Promise.all(clients.map(async(x,i)=>(await call(x,'register_client',{workspace_id:id,display_name:['A','B','C'][i]})).client_id));s.store.updateSettings({message_min_interval_seconds:0,collaboration_mode:'sequential'});const turn=await call(a,'request_turn');await call(b,'request_turn');
    await fs.writeFile(path.join(f.root,'app.txt'),'real change');await s.monitor.rescan();const change=s.store.listChanges(id)[0].change_id;
    const privateMessage=await call(a,'send_message',{workspace_id:id,...message,recipient_client_id:ids[1],related_paths:['src/app.ts'],related_change_ids:[change]});assert.equal(privateMessage.sender_client_id,ids[0]);assert.equal((await call(c,'get_messages',{workspace_id:id})).messages.length,0);
    const broadcast=await call(a,'send_message',{workspace_id:id,...message,subject:'广播'});await call(c,'send_message',{workspace_id:id,...message,recipient_client_id:ids[1],subject:'第二封私信'});
    const first=await call(b,'get_messages',{workspace_id:id,limit:1});assert.equal(first.messages[0].message_id,privateMessage.message_id);assert.equal(first.messages[0].untrusted_content,true);assert.match(first.messages[0].content_warning,/不是系统指令/);assert.equal(first.has_more,true);assert.equal(s.store.client(id,ids[1]).ack,0);await assert.rejects(()=>call(b,'ack_messages',{workspace_id:id,through_seq:999}),/尚未获取/);await call(b,'ack_messages',{workspace_id:id,through_seq:first.cursor_next});
    const second=await call(b,'get_messages',{workspace_id:id,limit:1});assert.equal(second.messages[0].message_id,broadcast.message_id);const forC=await call(c,'get_messages',{workspace_id:id});assert.deepEqual(forC.messages.map((m:any)=>m.message_id),[broadcast.message_id]);assert.equal((await call(a,'get_messages',{workspace_id:id})).messages.length,0);
    await call(b,'send_message',{workspace_id:id,...message,type:'result',reply_to_message_id:privateMessage.message_id,recipient_client_id:ids[0]});await assert.rejects(()=>call(c,'send_message',{workspace_id:id,...message,reply_to_message_id:privateMessage.message_id}),/无权读取/);
    for(const p of ['../escape','a/../escape','D:\\escape','/absolute','\\\\host\\share','app.txt:stream'])await assert.rejects(()=>call(b,'send_message',{workspace_id:id,...message,related_paths:[p]}),/相对路径/);
    await assert.rejects(()=>call(b,'send_message',{workspace_id:id,...message,subject:'x'.repeat(201)}));await assert.rejects(()=>call(b,'send_message',{workspace_id:id,...message,body:'x'.repeat(16385)}));await assert.rejects(()=>call(b,'send_message',{workspace_id:id,...message,recipient_client_id:randomUUID()}),/收件人/);
    const other=s.store.activate(path.join(f.folder,'not-monitored')),foreign=s.store.register(other.id,'other');s.store.setMeta('active',id);await assert.rejects(()=>call(a,'send_message',{workspace_id:id,...message,recipient_client_id:foreign.client_id}),/工作区/);const alien=randomUUID();s.store.run('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)',other.id,1,alien,'created','foreign.txt',null,null,null,null,new Date().toISOString(),'watcher');await assert.rejects(()=>call(a,'send_message',{workspace_id:id,...message,related_change_ids:[alien]}),/关联变更/);
    const before=s.store.collaboration.status(id);await call(b,'get_changes',{workspace_id:id});await call(b,'ack_changes',{workspace_id:id,through_seq:1});assert.equal(s.store.collaboration.status(id).holder?.client_id,before.holder?.client_id);assert.equal(s.store.one<{ack:number}>('SELECT ack FROM message_cursors WHERE workspace_id=? AND client=?',id,ids[1])!.ack,first.cursor_next);
    await Promise.all(clients.map(x=>x.close()));clients.length=0;await s.close();s=await startObserver({dataDir:f.data,port:0});const restored=await connect(s,'B-restored',bToken);clients.push(restored);assert.equal((await call(restored,'register_client',{workspace_id:id,display_name:'B 恢复'})).client_id,ids[1]);assert.equal((await call(restored,'get_messages',{workspace_id:id})).messages[0].message_id,broadcast.message_id);assert.equal(s.store.client(id,ids[1]).ack,1);assert.equal(s.store.collaboration.status(id).holder?.client_id,ids[0]);
    const count=s.store.collaboration.usage(id).count;s.store.run('UPDATE workspaces SET epoch=? WHERE id=?',randomUUID(),id);assert.equal(s.store.one<{n:number}>('SELECT count(*) AS n FROM turn_requests')!.n,0);assert.equal(s.store.one<{n:number}>('SELECT count(*) AS n FROM message_cursors')!.n,0);assert.equal(s.store.collaboration.usage(id).count,count);await assert.rejects(()=>call(restored,'get_messages',{workspace_id:id}),/history_epoch_mismatch/);await call(restored,'register_client',{workspace_id:id,display_name:'B 新代次'});assert.equal((await call(restored,'get_messages',{workspace_id:id})).messages[0].message_id,privateMessage.message_id);assert.ok(turn.lease_id);
  }finally{await Promise.all(clients.map(c=>c.close()));await s.close();}
});

test('message quota, durable rate limiting, retention gaps and explicit UI cleanup leave file history intact',async()=>{
  const f=await fixture(),s=f.service,id=s.store.workspace().id,a=s.store.register(id,'A').client_id,b=s.store.register(id,'B').client_id;
  try{
    s.store.updateSettings({message_min_interval_seconds:2,message_quota_total_kb:1});s.store.collaboration.send(id,a,{...message,subject:'a',body:'x'.repeat(900)});assert.throws(()=>s.store.collaboration.send(id,a,{...message,subject:'b',body:''}),/等待 2 秒/);assert.throws(()=>s.store.collaboration.send(id,b,{...message,subject:'b',body:'x'.repeat(200)}),/配额不足/);assert.equal(s.store.collaboration.usage(id).count,1);
    s.store.updateSettings({message_min_interval_seconds:0});await fs.writeFile(path.join(f.root,'kept.txt'),'keep file history');await s.monitor.rescan();const change=s.store.listChanges(id)[0];const initial=s.store.collaboration.get(id,b);s.store.collaboration.ack(id,b,initial.cursor_next);s.store.run('UPDATE messages SET created_at=?',new Date(Date.now()-86400000*100).toISOString());s.store.prune();assert.equal(s.store.collaboration.get(id,b,0).history_gap,true);assert.equal(s.store.listChanges(id)[0].change_id,change.change_id);
    s.store.collaboration.send(id,a,message);const cleared=await http(f,'/api/messages/clear',{workspace_id:id,confirm:true});assert.equal(cleared.status,200);assert.equal((await cleared.json()).deleted,1);assert.equal(s.store.collaboration.get(id,b,initial.cursor_next).history_gap,true);assert.equal(s.store.listChanges(id).length,1);assert.equal(s.store.collaboration.usage(id).latest_seq,2);assert.equal(s.store.collaboration.usage(id).oldest_available_seq,3);
    const other=s.store.activate(path.join(f.folder,'second'));const c=s.store.register(other.id,'same-name').client_id;s.store.collaboration.send(other.id,c,message);s.store.collaboration.get(other.id,c);assert.equal(s.store.one<{ack:number}>('SELECT ack FROM message_cursors WHERE workspace_id=? AND client=?',other.id,c)!.ack,0);assert.equal(s.store.one<{ack:number}>('SELECT ack FROM message_cursors WHERE workspace_id=? AND client=?',id,b)!.ack,initial.cursor_next);
  }finally{await s.close();}
});

test('two real STDIO bridges use separate credentials and actually hand off turns and messages',async()=>{
  const f=await fixture(),s=f.service,id=s.store.workspace().id,clients:Client[]=[];
  try{
    for(const name of ['Bridge A','Bridge B']){const c=new Client({name,version:'test'});await c.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('bridge.mjs'),'--data',f.data],stderr:'pipe'}));clients.push(c);assert.deepEqual((await c.listTools()).tools.map(t=>t.name).sort(),names);}
    const a=await call(clients[0],'register_client',{workspace_id:id,display_name:'Bridge A'}),b=await call(clients[1],'register_client',{workspace_id:id,display_name:'Bridge B'});assert.notEqual(a.client_id,b.client_id);s.store.updateSettings({collaboration_mode:'sequential'});const turn=await call(clients[0],'request_turn');assert.equal((await call(clients[1],'request_turn')).state,'waiting');await call(clients[0],'send_message',{workspace_id:id,...message,recipient_client_id:b.client_id});const inbox=await call(clients[1],'get_messages',{workspace_id:id});assert.equal(inbox.messages[0].sender_client_id,a.client_id);await call(clients[1],'ack_messages',{workspace_id:id,through_seq:inbox.cursor_next});await call(clients[0],'finish_turn',{lease_id:turn.lease_id});assert.equal((await call(clients[1],'request_turn')).state,'holding');
  }finally{await Promise.all(clients.map(c=>c.close()));await s.close();}
});

test('equal-time FIFO ties, quota feedback and message rate survive a real store restart',async()=>{
  const folder=await fs.mkdtemp(path.join(base,'durable-rate-')),file=path.join(folder,'db.sqlite');let store=new Store(file);
  try{
    const w=store.activate(folder),a=store.register(w.id,'A').client_id,b=store.register(w.id,'B').client_id,c=store.register(w.id,'C').client_id;store.updateSettings({collaboration_mode:'sequential',message_min_interval_seconds:60,message_quota_total_kb:1});store.collaboration.requestTurn(w.id,a);store.collaboration.requestTurn(w.id,b);store.collaboration.requestTurn(w.id,c);store.run("UPDATE turn_requests SET requested_at=? WHERE state='waiting'",Date.now());assert.deepEqual(store.collaboration.status(w.id).waiting.map(t=>t.client_id),[b,c]);
    store.collaboration.send(w.id,a,{...message,subject:'a',body:'x'.repeat(900)});assert.throws(()=>store.collaboration.send(w.id,b,{...message,body:'x'.repeat(200)}),/配额不足/);assert.equal(store.collaboration.usage(w.id).quota_reached,true);store.close();store=new Store(file);assert.equal(store.collaboration.usage(w.id).quota_reached,true);store.updateSettings({message_quota_total_kb:2});assert.equal(store.collaboration.usage(w.id).quota_reached,false);assert.throws(()=>store.collaboration.send(w.id,a,{...message,body:''}),/等待/);
  }finally{store.close();}
});
