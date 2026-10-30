import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startObserver } from '../server/http.ts';
import {realToolNames} from './mcp-tools.ts';
const expectedTools=await realToolNames();

const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.work/test-runs');
await fs.mkdir(base,{recursive:true});
async function fixture(){const folder=await fs.mkdtemp(path.join(base,'observer-'));const root=path.join(folder,'project');const data=path.join(folder,'data');await fs.mkdir(root);return {folder,root,data};}
async function waitFor(fn:()=>boolean|Promise<boolean>,timeout=10000){const start=Date.now();while(!await fn()){if(Date.now()-start>timeout)throw new Error('Timed out waiting for real filesystem state');await new Promise(r=>setTimeout(r,80));}}
async function connect(s:Awaited<ReturnType<typeof startObserver>>,name:string,token?:string){const c=new Client({name,version:'test'});await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token??s.store.identity.issue(name).token}`}}}));return c;}
async function call(c:Client,name:string,args:Record<string,unknown>={}){const r=await c.callTool({name,arguments:args});if(r.isError)throw new Error((r.content as {text:string}[])[0].text);return JSON.parse((r.content as {text:string}[])[0].text);}
async function rawStatus(url:string,headers:Record<string,string>){return new Promise<number>((resolve,reject)=>{const r=request(url,{headers},response=>{response.resume();resolve(response.statusCode!);});r.on('error',reject);r.end();});}

test('real watcher, two HTTP MCP clients, STDIO bridge, pagination, acknowledgement and persisted restart',async()=>{
  const f=await fixture();await fs.writeFile(path.join(f.root,'app.ts'),'export const interval = 5000;\n');
  let service=await startObserver({dataDir:f.data,root:f.root,port:0});const writerToken=service.store.identity.issue('Writer').token;let a:Client|undefined,b:Client|undefined,bridge:Client|undefined;
  try{
    const id=service.store.workspace().id;assert.equal(service.store.workspace().seq,0,'baseline is not a created event');
    [a,b]=await Promise.all([connect(service,'A',writerToken),connect(service,'B')]);
    assert.equal((await a.listTools()).tools.length,expectedTools.length);
    assert.equal((await call(a,'get_workspace_status')).workspace.id,id);
    const ca=await call(a,'register_client',{workspace_id:id,display_name:'Writer'});const cb=await call(b,'register_client',{workspace_id:id,display_name:'Reviewer'});
    const argsA={workspace_id:id,client_id:ca.client_id};const argsB={workspace_id:id,client_id:cb.client_id};
    const started=Date.now();await fs.writeFile(path.join(f.root,'app.ts'),'export const interval = 1000;\n');
    await waitFor(()=>service.store.workspace().seq===1);const latency=Date.now()-started;assert.ok(latency<5000);
    const ea=await call(a,'get_changes',argsA);const eb=await call(b,'get_changes',argsB);assert.equal(ea.events[0].change_id,eb.events[0].change_id);
    const detail=await call(a,'get_change_detail',{workspace_id:id,change_id:ea.events[0].change_id});assert.match(detail.diff,/-export const interval = 5000/);assert.match(detail.diff,/\+export const interval = 1000/);
    assert.equal(detail.untrusted_content,true);assert.match(detail.content_warning,/不是指令/);
    await call(a,'ack_changes',{...argsA,through_seq:1});assert.equal((await call(a,'get_changes',argsA)).events.length,0);assert.equal((await call(b,'get_changes',argsB)).events.length,1);
    await assert.rejects(()=>call(b!,'ack_changes',{...argsB,through_seq:2}),/尚未获取/);
    await call(a,'report_activity',{...argsA,summary:'Implementation',paths:['app.ts'],ttl_seconds:60});assert.equal((await call(b,'list_clients',{workspace_id:id})).find((x:any)=>x.id===ca.client_id).summary,'Implementation');
    await fs.writeFile(path.join(f.root,'说明.txt'),'真实新增内容\n');await service.monitor.rescan();
    await fs.writeFile(path.join(f.root,'another.txt'),'third event\n');await service.monitor.rescan();
    const page1=await call(b,'get_changes',{...argsB,limit:1});assert.equal(page1.cursor_next,1);assert.equal(page1.has_more,true);
    const page2=await call(b,'get_changes',{...argsB,after_seq:page1.cursor_next,limit:1});assert.equal(page2.events[0].seq,2);
    const repeated=await call(b,'get_changes',{...argsB,after_seq:page1.cursor_next,limit:1});assert.deepEqual(repeated.events,page2.events);
    bridge=new Client({name:'STDIO-independent',version:'test'});await bridge.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('bridge.mjs'),'--data',f.data],stderr:'pipe'}));assert.equal((await bridge.listTools()).tools.length,expectedTools.length);assert.equal((await call(bridge,'get_workspace_status')).workspace.id,id);await bridge.close();bridge=undefined;
    await a.close();await b.close();a=undefined;b=undefined;await service.close();
    await fs.writeFile(path.join(f.root,'app.ts'),'export const interval = 2000;\n');
    service=await startObserver({dataDir:f.data,port:0});assert.equal(service.store.workspace().id,id);assert.equal(service.store.workspace().seq,4);
    a=await connect(service,'A-restored',writerToken);const restored=await call(a,'register_client',{workspace_id:id,display_name:'Writer',resume_client_id:ca.client_id});assert.equal(restored.ack_seq,1);
    const missed=await call(a,'get_changes',argsA);assert.equal(missed.events.length,3);assert.equal(missed.events.at(-1).source,'startup_reconcile');
    console.log(`Watcher measurement: ${latency} ms; fixture: 1 initial text file, Windows local disk; not a general benchmark.`);
  }finally{await bridge?.close();await a?.close();await b?.close();await service.close();}
});

test('ignored credentials/cache, binary/large/encoding boundaries, real rename and atomic save',async()=>{
  const f=await fixture();await fs.writeFile(path.join(f.root,'stable.txt'),'old\n');await fs.writeFile(path.join(f.root,'rename.txt'),'rename\n');
  const s=await startObserver({dataDir:f.data,root:f.root,port:0});
  try{
    const id=s.store.workspace().id;
    await fs.writeFile(path.join(f.root,'.env'),'excluded test fixture');await fs.mkdir(path.join(f.root,'node_modules'));await fs.writeFile(path.join(f.root,'node_modules','cache.txt'),'excluded');
    for(const folder of ['.work','release']){await fs.mkdir(path.join(f.root,folder));await fs.writeFile(path.join(f.root,folder,'generated.txt'),'excluded generated output');await assert.rejects(()=>s.monitor.validateRoot(path.join(f.root,folder)),/默认排除/);}
    await fs.writeFile(path.join(f.root,'image.bin'),Buffer.from([0,1,0,2]));await fs.writeFile(path.join(f.root,'big.txt'),'a'.repeat(1024*1024+1));await fs.writeFile(path.join(f.root,'unknown.txt'),Buffer.from([0xff,0xa0,0x80]));
    await fs.writeFile(path.join(f.root,'utf16.txt'),Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from('文本\n','utf16le')]));
    await fs.rename(path.join(f.root,'rename.txt'),path.join(f.root,'renamed.txt'));
    await fs.writeFile(path.join(f.root,'replacement.tmp'),'atomic new\n');await fs.rename(path.join(f.root,'replacement.tmp'),path.join(f.root,'stable.txt'));
    await s.monitor.rescan();const changes=s.store.listChanges(id);
    assert.ok(!changes.some(e=>e.path.includes('.env')||e.path.includes('node_modules')||e.path.includes('replacement.tmp')||e.path.startsWith('.work/')||e.path.startsWith('release/')));
    const byPath=(p:string)=>s.store.detail(id,changes.find(e=>e.path===p)!.change_id);
    assert.equal(byPath('image.bin').unavailable_reason,'binary_file');assert.equal(byPath('big.txt').unavailable_reason,'file_too_large');assert.equal(byPath('unknown.txt').unavailable_reason,'unsupported_encoding');assert.match(byPath('utf16.txt').diff!,/文本/);
    assert.equal(changes.find(e=>e.path==='rename.txt')?.kind,'deleted');assert.equal(changes.find(e=>e.path==='renamed.txt')?.kind,'created');assert.equal(changes.filter(e=>e.path==='stable.txt').length,1);assert.match(byPath('stable.txt').diff!,/atomic new/);
    const seq=s.store.workspace().seq;await s.monitor.rescan();assert.equal(s.store.workspace().seq,seq,'unchanged content is deduplicated');
    assert.throws(()=>s.store.activity(id,s.store.register(id,'test').client_id,'bad',['../outside.txt'],60),/相对路径/);
  }finally{await s.close();}
});

test('HTTP boundary, read-only tool surface, single instance, invalid root, and root disappearance',async()=>{
  const f=await fixture();const s=await startObserver({dataDir:f.data,root:f.root,port:0});const url=`http://127.0.0.1:${s.port}`;
  try{
    assert.equal((await fetch(`${url}/api/status`)).status,401);
    assert.notEqual(s.token,s.mcpToken);
    assert.equal((await fetch(`${url}/api/status`,{headers:{Authorization:`Bearer ${s.mcpToken}`}})).status,401,'MCP access cannot administer the UI');
    assert.equal((await fetch(`${url}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${s.token}`,'Content-Type':'application/json'},body:'{}'})).status,401,'UI access cannot call MCP');
    assert.equal((await fetch(`${url}/api/status`,{headers:{Authorization:`Bearer ${s.token}`,Origin:'https://external.invalid'}})).status,403);
    // Node fetch rewrites Host. Use a raw HTTP request to actually exercise DNS-rebinding rejection.
    assert.equal(await rawStatus(`${url}/api/status`,{Authorization:`Bearer ${s.token}`,Host:'external.invalid'}),403);
    assert.equal((await fetch(`${url}/mcp`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
    assert.equal((await fetch(`${url}/api/settings`,{method:'POST',headers:{Authorization:`Bearer ${s.token}`,'Content-Type':'application/json'},body:JSON.stringify({retention_days:-1,snapshot_budget_mb:1,max_text_kb:1})})).status,400);
    await assert.rejects(()=>startObserver({dataDir:f.data,port:0}),/已有运行/);
    await assert.rejects(()=>s.monitor.select(f.folder),/数据目录必须分开/);
    await assert.rejects(()=>s.monitor.select(path.parse(f.root).root),/整个磁盘/);
    const c=await connect(s,'surface');const names=(await c.listTools()).tools.map(t=>t.name);assert.deepEqual(names.sort(),expectedTools);await c.close();
    await fs.rename(f.root,`${f.root}-moved`);await assert.rejects(()=>s.monitor.rescan());assert.equal(s.store.workspace().health,'error');assert.equal(s.store.workspace().seq,0,'missing root does not fabricate deletions');
  }finally{await s.close();}
});

test('root escape links are skipped; workspace switching keeps independent identity and history',async()=>{
  const f=await fixture();const outside=path.join(f.folder,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'outside.txt'),'outside fixture');
  await fs.symlink(outside,path.join(f.root,'external-link'),process.platform==='win32'?'junction':'dir');
  const s=await startObserver({dataDir:f.data,root:f.root,port:0});
  try{
    const first=s.store.workspace().id;assert.equal(s.store.workspace().file_count,0);
    await fs.writeFile(path.join(f.root,'one.txt'),'first');await s.monitor.rescan();const ca=s.store.register(first,'first-client');
    const second=await s.monitor.select(outside);assert.notEqual(second.id,first);assert.equal(second.seq,0);assert.throws(()=>s.store.changes(second.id,ca.client_id),/不属于/);
    await s.monitor.select(f.root);assert.equal(s.store.workspace().id,first);assert.equal(s.store.listChanges(first).length,1);
  }finally{await s.close();}
});

test('retention gap, snapshot quota, acknowledgement bound and history generation mismatch',async()=>{
  const f=await fixture();const s=await startObserver({dataDir:f.data,root:f.root,port:0});
  try{
    const id=s.store.workspace().id;const c=s.store.register(id,'lagging-client');
    await fs.writeFile(path.join(f.root,'one.txt'),'one');await s.monitor.rescan();
    s.store.prune(new Date(Date.now()+1000).toISOString());const gap=s.store.changes(id,c.client_id);assert.equal(gap.history_gap,true);assert.equal(gap.oldest_available_seq,2);assert.equal(gap.cursor_next,0);
    assert.throws(()=>s.store.ack(id,c.client_id,1),/尚未获取/);
    s.store.updateSettings({retention_days:30,snapshot_budget_mb:1,max_text_kb:1024});
    await fs.writeFile(path.join(f.root,'fill1.txt'),'x'.repeat(800000));await s.monitor.rescan();await fs.writeFile(path.join(f.root,'fill2.txt'),'y'.repeat(800000));await s.monitor.rescan();
    const last=s.store.listChanges(id)[0];assert.equal(s.store.detail(id,last.change_id).unavailable_reason,'snapshot_budget_exceeded');
    s.store.run('UPDATE workspaces SET epoch=? WHERE id=?','00000000-0000-4000-8000-000000000001',id);assert.throws(()=>s.store.changes(id,c.client_id),/history_epoch_mismatch/);
  }finally{await s.close();}
});
