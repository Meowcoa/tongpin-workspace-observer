import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {Store} from './store.ts';
import type {ClientEntry} from '../shared/client-types.ts';
const digest=(token:string)=>createHash('sha256').update(token).digest('hex');
export class Identity {
  constructor(private store:Store){store.db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_credentials(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,name TEXT NOT NULL,created TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,persistent INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS credential_clients(credential TEXT NOT NULL,workspace TEXT NOT NULL,client TEXT NOT NULL UNIQUE,PRIMARY KEY(credential,workspace));
    CREATE TABLE IF NOT EXISTS mcp_presence(credential TEXT PRIMARY KEY,host_name TEXT NOT NULL,connected_at TEXT NOT NULL,last_seen TEXT NOT NULL);
  `);}
  issue(name:string,persistent=false){const credential_id=randomUUID(),token=randomBytes(32).toString('base64url');this.store.run('INSERT INTO mcp_credentials(id,token_hash,name,created,persistent) VALUES(?,?,?,?,?)',credential_id,digest(token),name,new Date().toISOString(),persistent?1:0);return {credential_id,token};}
  authenticate(token:string){if(!token||token.length>256)return null;return this.store.one<{id:string}>('SELECT id FROM mcp_credentials WHERE token_hash=? AND revoked=0',digest(token))?.id??null;}
  profiles(){return this.store.all<{id:string;name:string;created:string;revoked:number}>('SELECT id,name,created,revoked FROM mcp_credentials WHERE persistent=1 ORDER BY created');}
  revoke(id:string){if(!this.store.one('SELECT 1 FROM mcp_credentials WHERE id=? AND persistent=1',id))throw new Error('接入身份不存在');this.store.transaction(()=>{this.store.run('UPDATE mcp_credentials SET revoked=1 WHERE id=?',id);this.store.run('DELETE FROM turn_requests WHERE client IN (SELECT client FROM credential_clients WHERE credential=?)',id);});}
  private credential(id:string){if(!this.store.one('SELECT 1 FROM mcp_credentials WHERE id=? AND revoked=0',id))throw new Error('MCP 连接身份已失效，请重新生成接入配置');}
  register(workspace:string,credential:string,name:string,resume?:string){
    return this.store.transaction(()=>{
      this.credential(credential);const w=this.store.workspace(workspace);
      let binding=this.store.one<{client:string}>('SELECT client FROM credential_clients WHERE credential=? AND workspace=?',credential,workspace);
      if(resume&&resume!==binding?.client)throw new Error('不能恢复其他连接的 client_id；请从本地界面绑定旧客户端');
      if(!binding){const c=this.store.register(workspace,name);this.store.run('INSERT INTO credential_clients VALUES(?,?,?)',credential,workspace,c.client_id);binding={client:c.client_id};}
      const old=this.store.one<{epoch:string}>('SELECT epoch FROM clients WHERE id=?',binding.client)!;
      if(old.epoch!==w.epoch)this.store.run('UPDATE clients SET epoch=?,ack=0,delivered=0 WHERE id=?',w.epoch,binding.client);
      this.store.run('UPDATE clients SET name=? WHERE id=?',name,binding.client);
      const c=this.store.client(workspace,binding.client);return {client_id:c.id,ack_seq:c.ack,epoch:c.epoch,workspace_id:workspace,identity_source:'connection_credential'};
    });
  }
  bindLegacy(workspace:string,credential:string,client:string){this.credential(credential);this.store.client(workspace,client);if(this.store.one('SELECT 1 FROM credential_clients WHERE client=?',client))throw new Error('该客户端已有专属接入身份');this.store.run('INSERT INTO credential_clients VALUES(?,?,?)',credential,workspace,client);}
  client(workspace:string,credential:string,claimed?:string){this.credential(credential);const binding=this.store.one<{client:string}>('SELECT client FROM credential_clients WHERE credential=? AND workspace=?',credential,workspace);if(!binding)throw new Error('请先 register_client 登记当前连接');if(claimed&&claimed!==binding.client)throw new Error('client_id 与当前连接身份不一致');return this.store.client(workspace,binding.client).id;}
  current(workspace:string,credential:string){this.credential(credential);return this.store.one<{client:string}>('SELECT client FROM credential_clients WHERE credential=? AND workspace=?',credential,workspace)?.client??null;}
  observeConnection(credential:string,hostName:string){this.credential(credential);const at=new Date().toISOString();this.store.run('INSERT INTO mcp_presence VALUES(?,?,?,?) ON CONFLICT(credential) DO UPDATE SET host_name=excluded.host_name,connected_at=excluded.connected_at,last_seen=excluded.last_seen',credential,hostName.trim().slice(0,100)||'MCP 客户端',at,at);}
  observeRequest(credential:string){this.store.run('UPDATE mcp_presence SET last_seen=? WHERE credential=?',new Date().toISOString(),credential);}
  listClients(workspace?:string):ClientEntry[]{
    const w=workspace?this.store.workspace(workspace):null;
    const rows=this.store.all<{credential_id:string;profile_name:string;persistent:number;revoked:number;host_name:string|null;connected_at:string|null;last_seen:string|null;id:string|null;client_name:string|null;epoch:string|null;ack:number|null;seen:string|null;summary:string|null;expires:string|null}>(`SELECT k.id AS credential_id,k.name AS profile_name,k.persistent,k.revoked,p.host_name,p.connected_at,p.last_seen,c.id,c.name AS client_name,c.epoch,c.ack,c.seen,a.summary,a.expires FROM mcp_credentials k LEFT JOIN mcp_presence p ON p.credential=k.id LEFT JOIN credential_clients b ON b.credential=k.id AND b.workspace=? LEFT JOIN clients c ON c.id=b.client LEFT JOIN activities a ON a.client=c.id WHERE (k.revoked=0 AND p.credential IS NOT NULL) OR c.id IS NOT NULL`,workspace??'');
    const at=new Date().toISOString();
    const entries:ClientEntry[]=rows.map(row=>{
      const registered=!!w&&!!row.id&&row.epoch===w.epoch,seen=[row.last_seen,row.seen].filter((x):x is string=>!!x).sort().at(-1)??at;
      return {entry_id:'credential:'+row.credential_id,id:row.id,credential_id:row.credential_id,name:row.client_name??(row.persistent?row.profile_name:row.host_name??row.profile_name),registration_status:registered?'registered':'unregistered',needs_reregistration:!!row.id&&!registered,can_register:!!w&&!row.revoked&&!!row.connected_at&&!registered,credential_revoked:!!row.revoked,observed_connection:!!row.connected_at,seen,last_connected_at:row.connected_at,ack:registered?row.ack:null,summary:row.expires&&row.expires>at?row.summary:null,recently_active:!row.revoked&&Date.now()-Date.parse(seen)<120000};
    });
    if(w){const legacy=this.store.clients(w.id).filter(c=>!this.store.one('SELECT 1 FROM credential_clients WHERE client=?',c.id));for(const c of legacy)entries.push({entry_id:'legacy:'+c.id,id:c.id,credential_id:null,name:c.name,registration_status:'registered',needs_reregistration:false,can_register:false,credential_revoked:false,observed_connection:false,seen:c.seen,last_connected_at:null,ack:c.ack,summary:c.summary,recently_active:c.recently_active});}
    return entries.sort((a,b)=>b.seen.localeCompare(a.seen));
  }
  registerFromUi(workspace:string,credential:string){
    if(this.store.meta('active')!==workspace)throw new Error('工作区已切换，请刷新客户端列表');
    this.credential(credential);
    const presence=this.store.one<{host_name:string}>('SELECT host_name FROM mcp_presence WHERE credential=?',credential);if(!presence)throw new Error('该身份尚未实际接入 MCP，请先在 AI 工具中连接');
    const existing=this.current(workspace,credential),w=this.store.workspace(workspace);
    const saved=existing?this.store.one<{name:string;epoch:string;ack:number}>('SELECT name,epoch,ack FROM clients WHERE id=?',existing):undefined;
    if(saved?.epoch===w.epoch)return {client_id:existing,workspace_id:workspace,ack_seq:saved.ack,already_registered:true};
    const profile=this.store.one<{name:string;persistent:number}>('SELECT name,persistent FROM mcp_credentials WHERE id=?',credential)!;
    return {...this.register(workspace,credential,saved?.name??(profile.persistent?profile.name:presence.host_name)),already_registered:false};
  }
}
