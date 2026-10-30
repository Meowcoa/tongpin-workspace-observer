import React, { lazy, Suspense, useCallback, useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './features/preview/preview.css';
import './features/collaboration/collaboration.css';
import './features/clients/clients.css';
import ClientsPanel from './features/clients/ClientsPanel.tsx';
import type {ClientEntry} from '../shared/client-types.ts';
import type {Settings,CollaborationStatus,MessageUsage} from '../shared/collaboration-types.ts';
const CollaborationSettings=lazy(()=>import('./features/collaboration/CollaborationSettings.tsx'));
const MessagesPage=lazy(()=>import('./features/collaboration/MessagesPage.tsx'));
const ConnectionPage=lazy(()=>import('./features/collaboration/ConnectionPage.tsx'));
import {ChangeDetails} from './features/preview/ChangeDetails.tsx';
const FilePreviewPage=lazy(()=>import('./features/preview/FilePreviewPage.tsx'));

type Workspace = { id:string; root:string; epoch:string; health:string; error:string|null; seq:number; file_count:number; scanned:string|null; oldest:number };
type Status = { workspace:Workspace|null; settings:Settings; data_dir:string; version:string;collaboration:CollaborationStatus|null;message_usage:MessageUsage|null };
type Change = { workspace_id:string; change_id:string; seq:number; path:string; kind:string; observed_at:string; source:string; before_hash:string|null; after_hash:string|null };
type Detail = Change & { diff:string|null; diff_truncated:boolean; unavailable_reason:string|null };
const kinds:Record<string,string> = { created:'新增', modified:'修改', deleted:'删除' };
const health:Record<string,string> = { watching:'监控中', indexing:'建立基线中', reconciling:'正在补查', paused:'已暂停', error:'监控异常' };
const reason:Record<string,string> = { binary_file:'这是二进制文件，仅保存变化信息。', file_too_large:'文件超过文本快照上限，仅保存变化信息。', unsupported_encoding:'无法可靠识别文本编码，没有生成文本差异。', snapshot_budget_exceeded:'快照额度不足，没有保存这次文本内容。', snapshot_pruned:'相关快照已清理，仍可查看变化信息。' };
const time = (s:string) => new Date(s).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
async function api<T>(url:string, init?:RequestInit):Promise<T> {
  const r=await fetch(`/api${url}`, { ...init, headers:{ 'Content-Type':'application/json', ...init?.headers } });
  const data=await r.json(); if(!r.ok) throw new Error(data.error ?? '请求失败'); return data;
}
const post = <T,>(url:string, data:unknown={}) => api<T>(url,{method:'POST',body:JSON.stringify(data)});
function Icon({name,size=20}:{name:string;size?:number}) {
  const paths:Record<string,React.ReactNode> = {
    mark:<><rect x="3" y="3" width="12" height="12"/><rect x="9" y="9" width="12" height="12"/></>,
    file:<><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4M9 12h6M9 16h6"/></>,
    clients:<><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m8 19-4 3v-5"/></>,
    link:<><path d="m10 13 4-4M8 15l-2 2a4 4 0 0 1-5-5l5-5a4 4 0 0 1 6 0M16 9l2-2a4 4 0 0 1 5 5l-5 5a4 4 0 0 1-6 0" transform="translate(0 -1) scale(.96)"/></>,
    search:<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    folder:<><path d="M3 6h7l2 3h9v11H3z"/></>,
    refresh:<><path d="M20 9a8 8 0 1 0 0 7M20 3v6h-6"/></>,
    close:<path d="m6 6 12 12M6 18 18 6"/>,
    arrow:<path d="m9 5 7 7-7 7"/>,
    up:<path d="m5 14 7-7 7 7"/>,
    play:<><circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/></>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]??paths.file}</svg>;
}
function FolderPicker({current,onClose,onSelect}:{current:string;onClose:()=>void;onSelect:(p:string)=>Promise<void>}) {
  const [input,setInput]=useState(current); const [listing,setListing]=useState<{path:string;parent:string|null;directories:{name:string;path:string}[]}>(); const [error,setError]=useState(''); const [busy,setBusy]=useState(false);
  const browse=useCallback(async(p:string)=>{setError('');try{setListing(await api(`/directories?path=${encodeURIComponent(p)}`));}catch(e){setError((e as Error).message);}},[]);
  useEffect(()=>{void browse(current);},[browse,current]);
  async function choose(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');try{await onSelect(input);onClose();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <div className="modal-backdrop"><section className="modal folder-modal" role="dialog" aria-modal="true" aria-labelledby="folder-title"><div className="modal-heading"><h2 id="folder-title">选择监控文件夹</h2><button className="icon-button" aria-label="关闭" onClick={onClose} disabled={busy}><Icon name="close"/></button></div><p className="muted-note">选择已有的本地项目，各个 AI 也打开同一文件夹。</p><form onSubmit={choose}><label htmlFor="folder-path">文件夹路径</label><div className="path-input"><input id="folder-path" value={input} onChange={e=>setInput(e.target.value)} placeholder="例如 D:\Projects\my-project" autoFocus/><button type="button" onClick={()=>void browse(input)} disabled={busy}>浏览</button></div>
    <div className="directory-heading"><span>{listing?.path || '本地磁盘'}</span><button type="button" className="text-button" onClick={()=>{setInput(listing?.parent??'');void browse(listing?.parent??'');}} disabled={busy || listing?.parent===null}><Icon name="up" size={16}/>上一级</button></div><div className="directory-list">{listing?.directories.map(d=><button type="button" key={d.path} onClick={()=>{setInput(d.path);void browse(d.path);}} disabled={busy}><Icon name="folder"/><span>{d.name}</span><Icon name="arrow" size={15}/></button>)}{listing && !listing.directories.length && <p className="muted-note">没有子文件夹，可以监控当前文件夹。</p>}</div>{error && <p className="error-text" role="alert">{error}</p>}<div className="modal-footer"><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" type="submit" disabled={!input || busy}>{busy?'正在建立基线…':'监控此文件夹'}</button></div></form></section></div>;
}
function DiffView({detail,loading}:{detail:Detail|null;loading:boolean}) {
  if(loading)return <div className="empty-detail"><p>正在读取差异…</p></div>;
  if(!detail)return <div className="empty-detail"><Icon name="file" size={36}/><h2>选择一条改动</h2><p>保存后的文件变化会出现在左侧。<br/>初次建立基线不会产生新增记录。</p></div>;
  return <section className="detail"><div className="detail-heading"><div><h2>{detail.path}</h2><p>{kinds[detail.kind]} / 修改者未知</p></div><span className="diff-label">差异</span></div>{detail.diff ? <div className="diff-code" role="region" aria-label="文件差异"><pre>{detail.diff.split('\n').map((line,i)=><div key={i} className={line.startsWith('+')&&!line.startsWith('+++')?'added':line.startsWith('-')&&!line.startsWith('---')?'removed':line.startsWith('@@')?'hunk':''}><span className="line-number">{i+1}</span><code>{line || ' '}</code></div>)}</pre></div> : <div className="no-diff"><Icon name="file" size={28}/><p>{reason[detail.unavailable_reason??'']??'这条记录没有可用的文本差异。'}</p></div>}{detail.diff_truncated && <p className="warning-text">差异已截断到 64 KiB；请重新读取当前文件。</p>}<dl className="metadata"><dt>文件路径</dt><dd>{detail.path}</dd><dt>旧版 SHA</dt><dd title={detail.before_hash??''}>{detail.before_hash??'无'}</dd><dt>新版 SHA</dt><dd title={detail.after_hash??''}>{detail.after_hash??'无'}</dd><dt>记录来源</dt><dd>{detail.source==='watcher'?'文件监听':detail.source==='startup_reconcile'?'重启补查':'目录补查'} · #{detail.seq} · {new Date(detail.observed_at).toLocaleString('zh-CN')}</dd></dl></section>;
}
function App(){
  const [page,setPage]=useState('changes'); const [status,setStatus]=useState<Status|null>(null); const [events,setEvents]=useState<Change[]>([]); const [clients,setClients]=useState<ClientEntry[]>([]); const [error,setError]=useState(''); const [picker,setPicker]=useState(false); const [selected,setSelected]=useState<string|null>(null); const [detail,setDetail]=useState<Detail|null>(null); const [detailLoading,setDetailLoading]=useState(false); const [query,setQuery]=useState(''); const [kind,setKind]=useState(''); const [busy,setBusy]=useState(false);
  const mainPane=useRef<HTMLElement>(null);
  const refresh=useCallback(async()=>{const next=await api<Status>('/status');setStatus(next);const [cl,ev]=await Promise.all([api<ClientEntry[]>('/clients'),next.workspace?api<Change[]>('/changes'):Promise.resolve([])]);setClients(cl);setEvents(ev);if(!next.workspace)setSelected(null);},[]);
  useEffect(()=>{mainPane.current?.scrollTo({top:0,left:0});},[page]);
  useEffect(()=>{const matches=events.filter(e=>e.path.toLowerCase().includes(query.toLowerCase())&&(!kind||e.kind===kind));setSelected(prev=>matches.some(e=>e.change_id===prev)?prev:matches[0]?.change_id??null);},[events,query,kind]);
  useEffect(()=>{let alive=true;let running=false;const update=async()=>{if(running||!alive)return;running=true;try{await refresh();if(alive)setError('');}catch(e){if(alive)setError((e as Error).message);}finally{running=false;}};void update();const t=setInterval(()=>void update(),1000);return()=>{alive=false;clearInterval(t);};},[refresh]);
  useEffect(()=>{let alive=true;if(!selected){setDetail(null);return;}setDetailLoading(true);api<Detail>(`/changes/${selected}`).then(d=>{if(alive)setDetail(d);}).catch(e=>{if(alive){setDetail(null);setError(e.message);}}).finally(()=>{if(alive)setDetailLoading(false);});return()=>{alive=false;};},[selected]);
  async function rescan(){setBusy(true);try{await post('/rescan');await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function chooseWorkspace(){if(!window.tongpinDesktop){setPicker(true);return;}try{const p=await window.tongpinDesktop.chooseFolder();if(p){await post('/workspace',{path:p});await refresh();}}catch(e){setError((e as Error).message);}}
  const w=status?.workspace;const registeredClients=clients.filter(c=>c.registration_status==='registered'&&c.id).map(c=>({id:c.id!,name:c.name}));const visible=events.filter(e=>e.path.toLowerCase().includes(query.toLowerCase())&&(!kind||e.kind===kind));
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><Icon name="mark" size={36}/><span>同频</span></div><nav aria-label="主导航">{[['changes','file','改动记录'],['preview','folder','文件预览'],['clients','clients','AI 客户端'],['messages','clients','协作消息'],['settings','play','协作设置'],['connection','link','连接 MCP']].map(([id,icon,label])=><button key={id} className={page===id?'selected':''} onClick={()=>setPage(id)}><Icon name={icon} size={24}/>{label}</button>)}</nav><div className="sidebar-bottom"><Icon name="play" size={22}/><span>{window.tongpinDesktop?'桌面版':'本地运行'}</span><span className="version">v{status?.version??'0.2.2'}</span></div></aside><main ref={mainPane} tabIndex={-1} aria-label="工作区内容"><header className="topbar"><div className="header-text"><div className="title-row"><h1>{page==='changes'?'改动记录':page==='preview'?'文件预览':page==='clients'?'AI 客户端':page==='messages'?'协作消息':page==='settings'?'协作设置':'连接 MCP'}</h1><span className={`status ${w?.health==='watching'?'ok':''}`}><span className={`dot ${w?.health==='watching'?'':'muted'}`}/>{w?health[w.health]??w.health:'未选择文件夹'}</span></div><p className="root-path" title={w?.root}>{w?.root??'选择一个已有项目，开始观察文件变化。'}</p></div><div className="header-actions"><button onClick={()=>void rescan()} disabled={!w||busy}><Icon name="refresh" size={17}/>{busy?'补查中…':'立即补查'}</button><button className="primary" onClick={()=>void chooseWorkspace()}><Icon name="folder" size={17}/>选择文件夹</button></div></header>{(error||w?.error)&&<div className="error-banner" role="alert">{error||w?.error}</div>}
    {page==='changes'?<><div className="summary"><span>文件变化会保留，每个 AI 独立读取。</span><span className="live-status"><span className={`dot ${error?'muted':''}`}/>{error?'连接异常':'每秒刷新'}</span></div><div className="workspace-body"><section className="event-pane" aria-label="改动列表"><div className="event-filters"><label className="search"><Icon name="search"/><input aria-label="搜索文件路径" placeholder="搜索文件路径" value={query} onChange={e=>setQuery(e.target.value)}/></label><select aria-label="改动类型" value={kind} onChange={e=>setKind(e.target.value)}><option value="">全部类型</option><option value="modified">修改</option><option value="created">新增</option><option value="deleted">删除</option></select></div><div className="event-table-head"><span>文件</span><span>类型</span><span>时间</span></div><div className="event-list">{visible.map(e=><button className={`event-row ${selected===e.change_id?'active':''}`} key={e.change_id} onClick={()=>setSelected(e.change_id)}><span className="event-file"><Icon name="file"/><span title={e.path}>{e.path}</span></span><span className={`kind ${e.kind}`}>{kinds[e.kind]}</span><time>{time(e.observed_at)}</time></button>)}{!visible.length&&<div className="empty-list"><Icon name="folder" size={30}/><strong>{!w?'选择项目文件夹':events.length?'没有匹配的记录':'等待文件变化'}</strong><p>{!w?'各 AI 工具使用同一个项目路径。':events.length?'换一个路径或类型试试。':'初始文件已作为基线，保存修改后会记录在这里。'}</p>{!w&&<button onClick={()=>setPicker(true)}>选择文件夹</button>}</div>}</div><div className="event-footer">最近 {events.length} 条记录{w?` · ${w.file_count} 个已索引文件`:''}</div></section><ChangeDetails loading={detailLoading} workspaceId={w?.id} detailWorkspaceId={detail?.workspace_id} path={detail?.path} changeId={detail?.change_id} hasDiff={!!detail?.diff} deleted={detail?.kind==='deleted'}><DiffView detail={detail} loading={detailLoading}/></ChangeDetails></div><ClientsPanel clients={clients} workspaceId={w?.id} onRegistered={refresh}/></>:page==='preview'?<Suspense fallback={<p className="preview-caption">正在载入文件预览…</p>}><FilePreviewPage workspace={w??undefined}/></Suspense>:page==='clients'?<ClientsPanel key={w?.id??'none'} clients={clients} workspaceId={w?.id} onRegistered={refresh} full/>:<Suspense fallback={<p className="preview-caption">正在载入…</p>}>{page==='settings'?<CollaborationSettings status={status} onRefresh={refresh}/>:page==='messages'?<MessagesPage key={w?.id??''} workspaceId={w?.id} clients={registeredClients}/>:<ConnectionPage clients={registeredClients}/>}</Suspense>}
    </main>{picker&&<FolderPicker current={w?.root??''} onClose={()=>setPicker(false)} onSelect={async p=>{await post('/workspace',{path:p});await refresh();}}/>}</div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
