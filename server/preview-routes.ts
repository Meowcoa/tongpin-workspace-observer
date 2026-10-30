import type {Express} from 'express';
import path from 'node:path';
import {z} from 'zod';
import {Store} from './store.ts';
import {PreviewError,listWorkspaceFiles,previewDocument,resolvePreviewItem,openPreviewFile,fileFormat,singleRange} from './preview.ts';

const query=z.object({workspace_id:z.string().uuid(),path:z.string().max(2048).default('')});
export function addPreviewRoutes(app:Express,store:Store){
  app.get('/api/files',async(req,res,next)=>{try{const input=query.parse(req.query);res.json(await listWorkspaceFiles(store,input.workspace_id,input.path));}catch(e){if(e instanceof PreviewError)res.status(e.status).json({error:e.message});else next(e);}});
  app.get('/api/preview',async(req,res,next)=>{
    try{const input=query.extend({encoding:z.enum(['auto','utf-8','gb18030','utf-16le','utf-16be']).default('auto')}).parse(req.query);res.json(await previewDocument(store,input.workspace_id,input.path,input.encoding));}
    catch(e){if(e instanceof PreviewError)res.status(e.status).json({error:e.message});else next(e);}
  });
  app.get('/api/preview-content',async(req,res,next)=>{
    let handle;
    try{
      const input=query.parse(req.query),item=await resolvePreviewItem(store,input.workspace_id,input.path);
      const [kind,mime]=fileFormat(item.relative);
      if(!['image','pdf','audio','video'].includes(kind))throw new PreviewError('此类型不通过原始媒体接口提供',403);
      const limit=kind==='image'?32*1024*1024:kind==='pdf'?50*1024*1024:2*1024*1024*1024;
      if(item.stat.size>limit)throw new PreviewError('文件超过媒体预览上限',413);
      if(req.headers.range)res.setHeader('Content-Range',`bytes */${item.stat.size}`);
      const range=singleRange(req.headers.range,item.stat.size);
      handle=await openPreviewFile(item);
      res.setHeader('Content-Type',mime);res.setHeader('Accept-Ranges','bytes');
      res.setHeader('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(path.basename(item.absolute)).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16))}`);
      res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      res.setHeader('Cross-Origin-Resource-Policy','same-origin');
      if(range.partial){res.status(206);res.setHeader('Content-Range',`bytes ${range.start}-${range.end}/${item.stat.size}`);}
      res.setHeader('Content-Length',item.stat.size===0?0:range.end-range.start+1);
      if(req.method==='HEAD'||item.stat.size===0){await handle.close();handle=undefined;res.end();return;}
      const stream=handle.createReadStream({start:range.start,end:range.end,autoClose:true});handle=undefined;
      res.once('close',()=>stream.destroy());stream.once('error',e=>res.destroy(e));stream.pipe(res);
    }catch(e){await handle?.close().catch(()=>{});if(res.headersSent){res.destroy();return;}if(e instanceof PreviewError){if(e.status===416&&!res.hasHeader('Content-Range'))res.setHeader('Content-Range','bytes */*');res.status(e.status).json({error:e.message});}else next(e);}
  });
}
