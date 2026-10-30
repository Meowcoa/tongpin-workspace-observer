import express, { type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Store } from './store.ts';
import { Monitor } from './monitor.ts';
import { makeMcp } from './mcp.ts';
import { addPreviewRoutes } from './preview-routes.ts';
import {settingsSchema} from './settings.ts';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function equal(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x,y); }
export async function startObserver(options: { dataDir: string; port?: number; root?: string; runtimeCommand?: {command:string;args:string[]} }) {
  const dataDir = path.resolve(options.dataDir); await fs.mkdir(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, 'service.lock');
  async function acquireLock() {
    try { const h = await fs.open(lockPath, 'wx'); await h.writeFile(String(process.pid)); await h.close(); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(await fs.readFile(lockPath, 'utf8'));
      if (!Number.isInteger(pid) || pid < 1) throw new Error('服务锁损坏，请核实数据目录中的 service.lock');
      try { process.kill(pid, 0); throw new Error('此数据目录已有运行中的服务'); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err; }
      await fs.unlink(lockPath); await acquireLock();
    }
  }
  await acquireLock();
  const keyPath = path.join(dataDir, 'access.key');
  try { await fs.writeFile(keyPath, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') { await fs.unlink(lockPath); throw e; } }
  const token = (await fs.readFile(keyPath, 'utf8')).trim();
  const mcpKeyPath = path.join(dataDir, 'mcp.key');
  try { await fs.writeFile(mcpKeyPath, randomBytes(32).toString('base64url'), { flag:'wx', mode:0o600 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') { await fs.unlink(lockPath); throw e; } }
  const mcpToken = (await fs.readFile(mcpKeyPath,'utf8')).trim();
  const store = new Store(path.join(dataDir, 'workspace.sqlite')); const monitor = new Monitor(store, dataDir);
  const app = express(); app.disable('x-powered-by'); const http = createServer(app); let port = options.port ?? 4318;
  app.use((req, res, next) => {
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!hosts.has(req.headers.host ?? '')) { res.status(403).json({ error: 'Host 不允许' }); return; }
    const origin = req.headers.origin;
    if (origin && !new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]).has(origin)) { res.status(403).json({ error: '跨站请求不允许' }); return; }
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Frame-Options','DENY'); res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self' blob:; worker-src 'self' blob:; font-src 'self' data: blob:; frame-ancestors 'none'");
    if(/^\/assets\/pdf\.worker[^/]*\.mjs$/.test(req.path))res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'");
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  function authorized(req: Request, res: Response, next: () => void) {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const cookie = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('observer='))?.slice(9) ?? '';
    if (!equal(token, bearer) && !equal(token, cookie)) { res.status(401).json({ error: '需要本地会话访问凭据' }); return; } next();
  }
  app.use('/api', authorized);
  addPreviewRoutes(app,store);
  app.get('/api/status', (_req,res) => { const workspace = store.meta('active') ? store.workspace() : null; res.json({ workspace, settings: store.settings(), collaboration:workspace?store.collaboration.status(workspace.id):null,message_usage:workspace?store.collaboration.usage(workspace.id):null, data_dir: dataDir, version:'0.2.2', desktop:!!options.runtimeCommand }); });
  app.post('/api/workspace', async (req,res) => { const input = z.object({ path: z.string().min(1).max(4096) }).parse(req.body); res.json(await monitor.select(input.path)); });
  app.post('/api/rescan', async (_req,res) => { res.json(await monitor.rescan()); });
  app.get('/api/changes', (req,res) => { const id = store.workspace().id; res.json(store.listChanges(id, z.coerce.number().int().min(1).max(500).default(200).parse(req.query.limit))); });
  app.get('/api/changes/:id', (req,res) => { res.json(store.detail(store.workspace().id, String(req.params.id))); });
  app.get('/api/clients', (_req,res) => {const id=store.meta('active'),turns=id?store.collaboration.status(id):null;res.json(store.identity.listClients(id).map(c=>({...c,turn:turns?[turns.holder,turns.expired_holder,...turns.waiting].find(t=>t?.client_id===c.id)??null:null})));});
  app.post('/api/clients/register',(req,res)=>{const input=z.object({workspace_id:z.string().uuid(),credential_id:z.string().uuid()}).strict().parse(req.body);res.json(store.identity.registerFromUi(input.workspace_id,input.credential_id));});
  const workspaceInput=z.object({workspace_id:z.string().uuid()}).strict();
  app.post('/api/turn/force-release',(req,res)=>{const input=workspaceInput.parse(req.body);res.json(store.collaboration.forceRelease(input.workspace_id));});
  app.get('/api/collaboration/audit',(_req,res)=>res.json(store.meta('active')?store.collaboration.audit(store.workspace().id):[]));
  app.get('/api/messages',(_req,res)=>res.json(store.meta('active')?store.collaboration.overview(store.workspace().id):{messages:[],usage:null}));
  app.post('/api/messages/clear',(req,res)=>{const input=workspaceInput.extend({confirm:z.literal(true)}).strict().parse(req.body);res.json(store.collaboration.clearMessages(input.workspace_id));});
  app.get('/api/mcp-profiles',(_req,res)=>res.json(store.identity.profiles()));
  app.post('/api/mcp-profiles',async(req,res)=>{
    const input=z.object({name:z.string().trim().min(1).max(100),legacy_client_id:z.string().uuid().optional()}).strict().parse(req.body);
    const created=store.identity.issue(input.name,true);
    try{if(input.legacy_client_id)store.identity.bindLegacy(store.workspace().id,created.credential_id,input.legacy_client_id);const dir=path.join(dataDir,'client-credentials');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,created.credential_id+'.key'),created.token,{flag:'wx',mode:0o600});res.json({id:created.credential_id,name:input.name});}
    catch(e){store.identity.revoke(created.credential_id);throw e;}
  });
  app.post('/api/mcp-profiles/:id/revoke',(req,res)=>{store.identity.revoke(z.string().uuid().parse(req.params.id));res.json({revoked:true});});
  app.get('/api/directories', async (req,res) => {
    const input = typeof req.query.path === 'string' ? req.query.path : '';
    if (!input) {
      const roots = process.platform === 'win32' ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(d => `${d}:\\`) : ['/'];
      const accessible = (await Promise.all(roots.map(async p => { try { await fs.access(p); return p; } catch { return null; } }))).filter(Boolean);
      res.json({ path: '', parent: null, directories: accessible.map(p => ({ name: p, path: p })) }); return;
    }
    if (!path.isAbsolute(input)) throw new Error('需要绝对路径');
    const folder = await fs.realpath(input);
    const entries = await fs.readdir(folder, { withFileTypes: true });
    res.json({ path: folder, parent: path.dirname(folder) === folder ? '' : path.dirname(folder), directories: entries.filter(x => x.isDirectory() && !x.isSymbolicLink() && !x.name.startsWith('.')).sort((a,b) => a.name.localeCompare(b.name)).map(x => ({ name:x.name, path:path.join(folder,x.name) })) });
  });
  app.get('/api/connection', (req,res) => {
    const bridge = path.join(appRoot, 'bridge.mjs');
    const profile=z.string().uuid().optional().parse(req.query.profile);
    if(profile&&!store.identity.profiles().some(p=>p.id===profile&&!p.revoked))throw new Error('接入身份不存在或已撤销');
    const baseRuntime = options.runtimeCommand ?? { command:'node',args:[bridge,'--data',dataDir] };
    const runtime={...baseRuntime,args:[...baseRuntime.args,...(profile?['--client',profile]:[])]};
    res.json({ url: `http://127.0.0.1:${port}/mcp`, desktop:!!options.runtimeCommand, codex: `[mcp_servers.workspace_observer]\ncommand = ${JSON.stringify(runtime.command)}\nargs = ${JSON.stringify(runtime.args)}\n`, generic: JSON.stringify({ mcpServers: { workspace_observer: runtime } }, null, 2), instructions: '身份由专属连接凭据确定，register_client 更新显示名；依次模式先申请回合，定期读取消息并独立确认。' });
  });
  app.post('/api/settings', (req,res) => { const settings = settingsSchema.partial().strict().parse(req.body); res.json(store.updateSettings(settings)); });
  // The legacy key can only mint a fresh, unrelated bridge identity. It cannot call tools or select another client's identity.
  app.post('/bridge/session',(req,res)=>{const bearer=req.headers.authorization?.replace(/^Bearer /,'')??'';if(!equal(mcpToken,bearer)){res.status(401).json({error:'需要本机桥接初始化凭据'});return;}res.json(store.identity.issue('临时桥接会话'));});
  app.all('/mcp', async (req,res) => {
    const credential=store.identity.authenticate(req.headers.authorization?.replace(/^Bearer /,'')??'');
    if(!credential){res.status(401).json({error:'需要客户端专属 MCP 凭据；旧共享凭据和界面会话不能调用 MCP，请重新加载桥接器或生成专属配置。'});return;}
    const server = makeMcp(store,credential); const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('finish',()=>{if(res.statusCode<200||res.statusCode>=300)return;try{const peer=server.server.getClientVersion();if(req.body?.method==='initialize'&&peer)store.identity.observeConnection(credential,peer.name);else store.identity.observeRequest(credential);}catch(e){console.error('同频：无法记录 MCP 接入状态。',(e as Error).message);}});
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport); await transport.handleRequest(req,res,req.body);
  });
  app.get('/', (_req,res) => { res.cookie('observer', token, { httpOnly:true, sameSite:'strict', path:'/' }); res.sendFile(path.join(appRoot,'dist','index.html')); });
  app.use(express.static(path.join(appRoot,'dist'), { index:false }));
  app.use((err: unknown, _req: Request, res: Response, _next: unknown) => { if (!res.headersSent) res.status(400).json({ error: err instanceof Error ? err.message : '请求失败' }); });
  let listening = false;
  try {
    if (options.root) await monitor.select(options.root);
    else if (store.meta('active')) { try { await monitor.select(store.workspace().root); } catch (e) { monitor.fail(e); } }
    await new Promise<void>((resolve,reject) => { http.once('error',reject); http.listen(port,'127.0.0.1', () => { port = (http.address() as { port:number }).port; listening = true; resolve(); }); });
    await fs.writeFile(path.join(dataDir,'connection.json'), JSON.stringify({ url:`http://127.0.0.1:${port}/mcp`, pid:process.pid }), 'utf8');
  } catch (e) { await monitor.close(); store.close(); await fs.unlink(lockPath); throw e; }
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await monitor.close(); if (listening) { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); } store.close(); await fs.unlink(lockPath); };
  return { app, http, store, monitor, port, token, mcpToken, close, dataDir };
}
