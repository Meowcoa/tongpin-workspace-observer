import {useEffect,useRef,useState} from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;

export default function PdfPreview({url}:{url:string}){
  const [doc,setDoc]=useState<pdfjs.PDFDocumentProxy|null>(null),[page,setPage]=useState(1),[zoom,setZoom]=useState(1),[width,setWidth]=useState(600),[error,setError]=useState(''),[rendered,setRendered]=useState(false);
  const host=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{const node=host.current;if(!node)return;const observer=new ResizeObserver(entries=>{const next=Math.floor(entries[0].contentRect.width);if(next>0)setWidth(next);});observer.observe(node);return()=>observer.disconnect();},[]);
  useEffect(()=>{
    const abort=new AbortController();let disposed=false,loading:pdfjs.PDFDocumentLoadingTask|undefined;
    setDoc(null);setError('');setPage(1);setRendered(false);
    void(async()=>{
      const response=await fetch(url,{signal:abort.signal});if(!response.ok)throw new Error('无法读取 PDF 文件');
      const data=new Uint8Array(await response.arrayBuffer());if(disposed)return;
      loading=pdfjs.getDocument({data,cMapUrl:new URL('/pdfjs/cmaps/',location.origin).href,cMapPacked:true,standardFontDataUrl:new URL('/pdfjs/standard_fonts/',location.origin).href,wasmUrl:new URL('/pdfjs/wasm/',location.origin).href,enableXfa:false,useWorkerFetch:true});
      const loaded=await loading.promise;if(disposed){await loading.destroy();return;}setDoc(loaded);
    })().catch(e=>{if(!disposed&&e.name!=='AbortError')setError(e.message||'PDF 无法解析，可能已加密或损坏。');});
    return()=>{disposed=true;abort.abort();void loading?.destroy().catch(()=>{});};
  },[url]);
  useEffect(()=>{
    if(!doc||!canvas.current)return;let disposed=false,task:pdfjs.RenderTask|undefined;setRendered(false);setError('');
    void(async()=>{
      const pdfPage=await doc.getPage(page);if(disposed||!canvas.current)return;
      const base=pdfPage.getViewport({scale:1});const viewport=pdfPage.getViewport({scale:Math.max(.1,Math.min(2,(width-32)/base.width))*zoom});
      const scale=Math.min(devicePixelRatio||1,2,8192/viewport.width,8192/viewport.height,Math.sqrt(16000000/(viewport.width*viewport.height)));
      const node=canvas.current;node.width=Math.max(1,Math.floor(viewport.width*scale));node.height=Math.max(1,Math.floor(viewport.height*scale));node.style.width=`${viewport.width}px`;node.style.height=`${viewport.height}px`;
      task=pdfPage.render({canvas:node,canvasContext:node.getContext('2d')!,viewport,transform:[scale,0,0,scale,0,0]});
      await task.promise;if(!disposed)setRendered(true);
    })().catch(e=>{if(!disposed&&e.name!=='RenderingCancelledException')setError(e.message||'PDF 页面渲染失败');});
    return()=>{disposed=true;task?.cancel();};
  },[doc,page,zoom,width]);
  return <div className="pdf-preview" ref={host}><div className="preview-controls"><button onClick={()=>setPage(p=>p-1)} disabled={!doc||page<=1}>上一页</button><span aria-live="polite">{doc?`${page} / ${doc.numPages}`:'正在读取 PDF…'}</span><button onClick={()=>setPage(p=>p+1)} disabled={!doc||page>=doc.numPages}>下一页</button><select aria-label="PDF 缩放" value={zoom} onChange={e=>setZoom(Number(e.target.value))}><option value={.75}>75%</option><option value={1}>适合宽度</option><option value={1.25}>125%</option><option value={1.5}>150%</option></select></div>{error&&<p className="preview-error" role="alert">{error}</p>}<div className="pdf-canvas-scroll"><canvas ref={canvas} aria-label={`PDF 第 ${page} 页`} data-rendered={rendered}/></div><p className="preview-caption">{rendered?'页面已渲染；不执行 PDF 脚本或打开文档链接。':'页面渲染中…'}</p></div>;
}
