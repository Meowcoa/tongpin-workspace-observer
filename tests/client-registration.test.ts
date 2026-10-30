import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {startObserver} from '../server/http.ts';
import type {ClientEntry} from '../shared/client-types.ts';
const base=path.resolve('.work/test-runs');await fs.mkdir(base,{recursive:true});
async function fixture(rootSelected=true){const folder=await fs.mkdtemp(path.join(base,'client-directory-')),root=path.join(folder,'project'),data=path.join(folder,'data');await fs.mkdir(root);return {folder,root,data,service:await startObserver({dataDir:data,root:rootSelected?root:undefined,port:0})};}
async function ui(s:Awaited<ReturnType<typeof startObserver>>,route:string,body?:unknown,token=s.token){return fetch(`http://127.0.0.1:${s.port}/api`+route,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function directory(s:Awaited<ReturnType<typeof startObserver>>):Promise<ClientEntry[]>{const r=await ui(s,'/clients');assert.equal(r.status,200);return r.json();}
async function connect(s:Awaited<ReturnType<typeof startObserver>>,token:string,name='WorkBuddy handshake test'){const c=new Client({name,version:'1'});await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));return c;}
async function call(c:Client,name:string,args:Record<string,unknown>={}){const r=await c.callTool({name,arguments:args});if(r.isError)throw new Error((r.content as {text:string}[])[0].text);return JSON.parse((r.content as {text:string}[])[0].text);}

test('MCP handshake appears unregistered; UI registers the actual credential once without model registration',async()=>{
  const f=await fixture(),s=f.service,identity=s.store.identity.issue('WorkBuddy',true),id=s.store.workspace().id;let c:Client|undefined;
  try{
    assert.equal((await directory(s)).length,0,'Creating a configuration does not claim a successful connection');
    c=await connect(s,identity.token);let rows=await directory(s);assert.equal(rows.length,1);assert.equal(rows[0].name,'WorkBuddy');assert.equal(rows[0].registration_status,'unregistered');assert.equal(rows[0].id,null);assert.equal(rows[0].observed_connection,true);assert.equal(rows[0].can_register,true);assert.equal(rows[0].ack,null);assert.equal((await call(c,'get_workspace_status')).session_client_id,null);assert.equal(s.store.clients(id).length,0);
    const body={workspace_id:id,credential_id:identity.credential_id};assert.equal((await ui(s,'/clients/register',body,identity.token)).status,401,'MCP credentials cannot use UI registration');
    const results=await Promise.all([ui(s,'/clients/register',body),ui(s,'/clients/register',body)]);assert.ok(results.every(r=>r.status===200));const ids=await Promise.all(results.map(r=>r.json() as Promise<{client_id:string}>));assert.equal(ids[0].client_id,ids[1].client_id);assert.equal(s.store.clients(id).length,1);
    rows=await directory(s);assert.equal(rows[0].registration_status,'registered');assert.equal(rows[0].id,ids[0].client_id);assert.equal((await call(c,'get_workspace_status')).session_client_id,ids[0].client_id);
    await fs.writeFile(path.join(f.root,'example.txt'),'one actual change');await s.monitor.rescan();const changes=await call(c,'get_changes',{workspace_id:id});assert.equal(changes.events.length,1);await call(c,'ack_changes',{workspace_id:id,through_seq:changes.cursor_next});
    await call(c,'register_client',{workspace_id:id,display_name:'WorkBuddy 自报名称'});const again=await ui(s,'/clients/register',body);assert.equal((await again.json()).already_registered,true);assert.equal(s.store.clients(id)[0].ack,1);assert.equal(s.store.clients(id)[0].name,'WorkBuddy 自报名称');
    assert.equal((await ui(s,'/clients/register',{...body,workspace_id:randomUUID()})).status,400);assert.equal((await ui(s,'/clients/register',{...body,client_id:randomUUID()})).status,400);
    const unused=s.store.identity.issue('Only configured',true);assert.equal((await ui(s,'/clients/register',{workspace_id:id,credential_id:unused.credential_id})).status,400);
  }finally{await c?.close();await s.close();}
});

test('connections are visible before choosing a workspace; registration is scoped to the active workspace',async()=>{
  const f=await fixture(false),s=f.service,identity=s.store.identity.issue('Temporary connection');let c:Client|undefined;
  try{
    c=await connect(s,identity.token,'未选择项目的 AI');let rows=await directory(s);assert.equal(rows.length,1);assert.equal(rows[0].name,'未选择项目的 AI');assert.equal(rows[0].registration_status,'unregistered');assert.equal(rows[0].can_register,false);
    const first=await s.monitor.select(f.root);rows=await directory(s);assert.equal(rows[0].can_register,true);const registered=await (await ui(s,'/clients/register',{workspace_id:first.id,credential_id:identity.credential_id})).json();assert.ok(registered.client_id);
    const other=path.join(f.folder,'second');await fs.mkdir(other);const second=await s.monitor.select(other);rows=await directory(s);assert.equal(rows[0].registration_status,'unregistered');assert.equal(rows[0].id,null);assert.equal((await ui(s,'/clients/register',{workspace_id:first.id,credential_id:identity.credential_id})).status,400);
    const next=await (await ui(s,'/clients/register',{workspace_id:second.id,credential_id:identity.credential_id})).json();assert.notEqual(next.client_id,registered.client_id);await s.monitor.select(f.root);assert.equal((await directory(s))[0].id,registered.client_id);
  }finally{await c?.close();await s.close();}
});

test('connection and registration records survive restart, old clients remain visible, revoked identities cannot register',async()=>{
  const f=await fixture();let s=f.service,c:Client|undefined;const id=s.store.workspace().id,identity=s.store.identity.issue('Persisted pending',true);
  try{
    const legacy=s.store.register(id,'旧客户端');c=await connect(s,identity.token);await c.close();c=undefined;await s.close();s=await startObserver({dataDir:f.data,port:0});let rows=await directory(s);assert.ok(rows.some(r=>r.id===legacy.client_id&&r.registration_status==='registered'));const pending=rows.find(r=>r.credential_id===identity.credential_id)!;assert.equal(pending.registration_status,'unregistered');assert.ok(pending.last_connected_at);
    const result=await (await ui(s,'/clients/register',{workspace_id:id,credential_id:identity.credential_id})).json();s.store.run('UPDATE workspaces SET epoch=? WHERE id=?',randomUUID(),id);rows=await directory(s);const changed=rows.find(r=>r.credential_id===identity.credential_id)!;assert.equal(changed.registration_status,'unregistered');assert.equal(changed.needs_reregistration,true);const renewed=await (await ui(s,'/clients/register',{workspace_id:id,credential_id:identity.credential_id})).json();assert.equal(renewed.client_id,result.client_id);
    s.store.identity.revoke(identity.credential_id);assert.equal((await ui(s,'/clients/register',{workspace_id:id,credential_id:identity.credential_id})).status,400);rows=await directory(s);assert.equal(rows.find(r=>r.id===result.client_id)?.credential_revoked,true);
  }finally{await c?.close();await s.close();}
});
