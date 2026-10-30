import {lazy,Suspense,useEffect,useState,type ReactNode} from 'react';
const PreviewPane=lazy(()=>import('./PreviewPane.tsx'));
export function ChangeDetails({workspaceId,detailWorkspaceId,path,changeId,hasDiff,deleted,loading,children}:{workspaceId?:string;detailWorkspaceId?:string;path?:string;changeId?:string;hasDiff:boolean;deleted:boolean;loading:boolean;children:ReactNode}){
  const [tab,setTab]=useState<'diff'|'preview'>('diff');
  useEffect(()=>{setTab(hasDiff||deleted?'diff':'preview');},[changeId,hasDiff,deleted]);
  if(loading||!path||!changeId)return <div className="change-details">{children}</div>;
  if(detailWorkspaceId&&detailWorkspaceId!==workspaceId)return <div className="preview-placeholder">工作区正在更新，请稍候…</div>;
  return <div className="change-details"><div className="detail-tabs" role="tablist" aria-label="文件详情视图"><button role="tab" aria-selected={tab==='diff'} onClick={()=>setTab('diff')}>改动差异</button><button role="tab" aria-selected={tab==='preview'} onClick={()=>setTab('preview')}>文件预览</button></div>{tab==='diff'?children:deleted?<p className="preview-error">文件已删除，不能预览当前版本；可切回差异查看保存过的文本。</p>:<Suspense fallback={<p className="preview-caption">正在载入预览组件…</p>}><PreviewPane workspaceId={workspaceId} path={path} revision={changeId} compact/></Suspense>}</div>;
}
