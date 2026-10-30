import {promises as fs,constants,type Stats} from 'node:fs';
import path from 'node:path';
import {TextDecoder} from 'node:util';
import Papa from 'papaparse';
import {unzipSync} from 'fflate';
import {Store} from './store.ts';
import {inside,ignored} from './monitor.ts';
import {readOfficeParts,wordPreview,spreadsheetPreview,presentationPreview} from './preview-office.ts';
import type {FileListing,PreviewDocument,PreviewKind,TextEncoding} from '../shared/preview-types.ts';

export class PreviewError extends Error{constructor(message:string,public status=400){super(message);}}
const types:Record<string,[PreviewKind,string]>={};
function register(extensions:string,kind:PreviewKind,mime:string){for(const ext of extensions.split(' '))types['.'+ext]=[kind,mime];}
register('txt log ini conf cfg toml yaml yml xml sql jsonl ts tsx js jsx mjs cjs py java c cpp h hpp cs rs go sh ps1 bat cmd css scss less vue svelte unity prefab mat asset meta gitignore gitattributes','text','text/plain');
register('md markdown mdown','markdown','text/markdown');register('html htm','html','text/html');register('json','json','application/json');
register('csv tsv','table','text/csv');register('pdf','pdf','application/pdf');
for(const [ext,mime] of Object.entries({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',bmp:'image/bmp',svg:'image/svg+xml',ico:'image/x-icon',avif:'image/avif'}))register(ext,'image',mime);
for(const [ext,mime] of Object.entries({mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',oga:'audio/ogg',flac:'audio/flac',m4a:'audio/mp4',aac:'audio/aac',opus:'audio/ogg'}))register(ext,'audio',mime);
for(const [ext,mime] of Object.entries({mp4:'video/mp4',m4v:'video/mp4',webm:'video/webm',ogv:'video/ogg',mov:'video/quicktime',mkv:'video/x-matroska',avi:'video/x-msvideo'}))register(ext,'video',mime);
register('docx docm dotx','word','application/vnd.openxmlformats-officedocument.wordprocessingml.document');
register('xlsx xlsm xltx','spreadsheet','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
register('pptx pptm ppsx potx','presentation','application/vnd.openxmlformats-officedocument.presentationml.presentation');
register('zip jar nupkg vsix epub 3mf','archive','application/zip');
export function fileFormat(name:string){return types[path.extname(name).toLowerCase()]??(['unsupported','application/octet-stream'] as const);}

export type PreviewItem={workspace_id:string;root:string;absolute:string;relative:string;stat:Stats};
export async function resolvePreviewItem(store:Store,id:string,relative:string):Promise<PreviewItem>{
  let workspace;try{workspace=store.workspace();}catch{throw new PreviewError('请先选择工作区',404);}
  if(workspace.id!==id)throw new PreviewError('工作区已切换，请重新选择文件',409);
  const rel=relative.replace(/\\/g,'/');
  if(rel.length>2048||rel.includes('\0')||rel.includes(':')||/^[\/]/.test(rel)||rel.split('/').includes('..'))throw new PreviewError('只允许当前工作区内的相对路径',403);
  const absolute=path.resolve(workspace.root,...rel.split('/').filter(Boolean));
  if(!inside(workspace.root,absolute)||ignored(workspace.root,absolute))throw new PreviewError('该路径被工作区访问规则排除',403);
  try{
    if(await fs.realpath(workspace.root)!==workspace.root)throw new PreviewError('工作区根目录已改变',409);
    let current=workspace.root;
    for(const part of path.relative(workspace.root,absolute).split(path.sep).filter(Boolean)){
      current=path.join(current,part);if((await fs.lstat(current)).isSymbolicLink())throw new PreviewError('预览不跟随符号链接或 junction',403);
    }
    const real=await fs.realpath(absolute);
    if(!inside(workspace.root,real)||(process.platform==='win32'?real.toLowerCase()!==absolute.toLowerCase():real!==absolute))throw new PreviewError('文件实际位置不在允许范围内',403);
    const stat=await fs.lstat(real);
    return {workspace_id:id,root:workspace.root,absolute:real,relative:path.relative(workspace.root,real).split(path.sep).join('/'),stat};
  }catch(e){if(e instanceof PreviewError)throw e;const code=(e as NodeJS.ErrnoException).code;throw new PreviewError(code==='ENOENT'?'文件不存在或已删除':'无法读取文件或目录',code==='ENOENT'?404:403);}
}

export async function openPreviewFile(item:PreviewItem){
  if(!item.stat.isFile())throw new PreviewError('请选择普通文件');
  const handle=await fs.open(item.absolute,constants.O_RDONLY);
  try{
    const stat=await handle.stat();
    if(!stat.isFile()||stat.ino!==item.stat.ino||stat.dev!==item.stat.dev||await fs.realpath(item.absolute)!==item.absolute)throw new PreviewError('文件已变化，请刷新后重试',409);
    return handle;
  }catch(e){await handle.close();throw e;}
}
async function readBounded(item:PreviewItem,limit:number,allowPrefix=false){
  if(item.stat.size>limit&&!allowPrefix)throw new PreviewError(`文件超过此类型的预览上限（${Math.round(limit/1024/1024)} MiB）`,413);
  const handle=await openPreviewFile(item);
  try{
    const output=Buffer.alloc(Math.min(item.stat.size,limit)+1);let position=0;
    while(position<output.length){const {bytesRead}=await handle.read(output,position,output.length-position,position);if(!bytesRead)break;position+=bytesRead;}
    const after=await handle.stat();
    if((position>limit&&!allowPrefix)||after.size!==item.stat.size||after.mtimeMs!==item.stat.mtimeMs)throw new PreviewError('文件正在变化，请稍后刷新',409);
    return output.subarray(0,Math.min(position,limit));
  }finally{await handle.close();}
}

export async function listWorkspaceFiles(store:Store,id:string,relative:string):Promise<FileListing>{
  const item=await resolvePreviewItem(store,id,relative);if(!item.stat.isDirectory())throw new PreviewError('请选择文件夹');
  const all=await fs.readdir(item.absolute,{withFileTypes:true});
  const visible=all.filter(x=>!x.isSymbolicLink()&&(x.isFile()||x.isDirectory())&&!ignored(item.root,path.join(item.absolute,x.name))).sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name,'zh-CN',{numeric:true}));
  const entries=[];
  for(let start=0;start<Math.min(visible.length,2000);start+=32){
    const chunk=await Promise.all(visible.slice(start,Math.min(start+32,2000)).map(async entry=>{
      const rel=[item.relative,entry.name].filter(Boolean).join('/');
      try{const safe=await resolvePreviewItem(store,id,rel);return {name:entry.name,path:rel,directory:safe.stat.isDirectory(),size:safe.stat.size,modified_at:safe.stat.mtime.toISOString(),kind:fileFormat(entry.name)[0]};}catch{return null;}
    }));entries.push(...chunk.filter((x):x is NonNullable<typeof x>=>x!==null));
  }
  const parent=item.relative?item.relative.split('/').slice(0,-1).join('/'):null;
  return {workspace_id:id,path:item.relative,parent,entries,truncated:visible.length>2000};
}

function decode(bytes:Buffer,requested:TextEncoding){
  let encoding:string=requested;
  if(requested==='auto'){
    if(bytes[0]===0xff&&bytes[1]===0xfe)encoding='utf-16le';
    else if(bytes[0]===0xfe&&bytes[1]===0xff)encoding='utf-16be';
    else{
      if(bytes.includes(0))throw new Error('检测到二进制内容，不能作为普通文本解码');
      try{return {text:new TextDecoder('utf-8',{fatal:true}).decode(bytes),encoding:'utf-8',guessed:false};}catch{encoding='gb18030';}
    }
  }
  return {text:new TextDecoder(encoding,{fatal:true}).decode(bytes),encoding,guessed:requested==='auto'&&encoding==='gb18030'};
}

export async function previewDocument(store:Store,id:string,relative:string,encoding:TextEncoding='auto'):Promise<PreviewDocument>{
  const item=await resolvePreviewItem(store,id,relative);if(!item.stat.isFile())throw new PreviewError('请选择普通文件');
  const [kind,mime]=fileFormat(item.relative);
  const result:PreviewDocument={workspace_id:id,path:item.relative,name:path.basename(item.absolute),kind,mime,size:item.stat.size,modified_at:item.stat.mtime.toISOString(),truncated:false,notices:[]};
  if(['image','pdf','audio','video'].includes(kind)){
    const limit=kind==='image'?32*1024*1024:kind==='pdf'?50*1024*1024:2*1024*1024*1024;
    if(item.stat.size>limit)return {...result,kind:'unsupported',notices:[`文件超过 ${limit/1024/1024} MiB 预览上限`]};
    result.content_url=`/api/preview-content?workspace_id=${id}&path=${encodeURIComponent(item.relative)}&v=${Math.trunc(item.stat.mtimeMs)}-${item.stat.size}`;
    if(kind==='audio'||kind==='video')result.notices.push('能否播放取决于文件所用编码；不进行在线转码。');
    return result;
  }
  if(['word','spreadsheet','presentation','archive'].includes(kind)){
    try{
      const bytes=await readBounded(item,32*1024*1024);
      if(kind==='archive'){
        const entries:NonNullable<PreviewDocument['entries']>=[];
        try{unzipSync(bytes,{filter:entry=>{if(entries.length>=2000)throw new Error('entry_limit');entries.push({name:entry.name,size:entry.originalSize,compressed_size:entry.size,directory:entry.name.endsWith('/')});return false;}});}catch(e){if((e as Error).message!=='entry_limit')throw e;result.truncated=true;}
        return {...result,entries,notices:['只查看压缩包目录，不解压或执行其中的文件。']};
      }
      const parts=readOfficeParts(bytes);
      if(kind==='word')return {...result,...wordPreview(parts),notices:['Word 内容预览：正文和表格；不复刻原版分页、图片与复杂排版。']};
      if(kind==='spreadsheet')return {...result,...spreadsheetPreview(parts),notices:['显示已保存的单元格值；无缓存值时显示公式文字，不运行公式、宏、外部连接或图表。每表最多 200 行、50 列。']};
      return {...result,...presentationPreview(parts),notices:['按幻灯片查看文字内容；不还原动画、图片与原版版式。']};
    }catch(e){return {...result,kind:'unsupported',notices:[`无法进行内容预览：${(e as Error).message}`]};}
  }
  const ext=path.extname(item.relative).toLowerCase();
  if(kind==='unsupported'&&['.doc','.xls','.ppt','.exe','.dll','.pdb','.7z','.rar','.psd','.tif','.tiff','.heic','.heif'].includes(ext))return {...result,notices:[['.doc','.xls','.ppt'].includes(ext)?'旧版 Office 可转换为 DOCX/XLSX/PPTX 或 PDF 后预览。':'暂不支持这种格式的内容预览。']};
  try{
    let bytes=await readBounded(item,2*1024*1024,true);
    result.truncated=item.stat.size>bytes.length;
    if(result.truncated){
      result.notices.push('大文本仅预览前 2 MiB。');
      if(encoding==='auto'||encoding==='utf-8'){
        for(let cut=0;cut<4;cut++){try{new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,bytes.length-cut));bytes=bytes.subarray(0,bytes.length-cut);break;}catch{}}
      }
    }
    const decoded=decode(bytes,encoding);
    result.text=decoded.text;result.encoding=decoded.encoding;
    if(decoded.guessed)result.notices.push('自动尝试了 GB18030；如显示不正确，可手动切换编码。');
    if(kind==='unsupported')result.kind='text';
    if(kind==='json'){try{result.text=JSON.stringify(JSON.parse(decoded.text),null,2);}catch{result.notices.push(result.truncated?'JSON 内容已截断，按片段原文显示。':'JSON 语法无效，按原文显示。');}}
    if(kind==='table'){
      const table=Papa.parse<string[]>(decoded.text,{preview:201,delimiter:ext==='.tsv'?'\t':'',skipEmptyLines:'greedy',dynamicTyping:false});
      result.rows=table.data.slice(0,200).map(row=>row.slice(0,50));result.truncated||=table.meta.truncated||table.data.length>200||table.data.some(row=>row.length>50);
      if(table.errors.length)result.notices.push('部分 CSV 行格式不规范，显示解析到的内容。');delete result.text;
    }
    if(result.text&&result.text.length>300000){result.text=result.text.slice(0,300000);const last=result.text.charCodeAt(result.text.length-1);if(last>=0xd800&&last<=0xdbff)result.text=result.text.slice(0,-1);result.truncated=true;result.notices.push('可见文本限制为前 300,000 个字符。');}
    return result;
  }catch(e){return {...result,kind:'unsupported',notices:[(e as Error).message||'无法可靠解码该文件']};}
}

export function singleRange(range:string|undefined,size:number){
  if(!range)return {start:0,end:Math.max(0,size-1),partial:false};
  const m=/^bytes=(\d*)-(\d*)$/.exec(range);
  if(!m||(!m[1]&&!m[2])||size===0)throw new PreviewError('无效的文件范围',416);
  let start:number,end:number;
  if(!m[1]){const suffix=Number(m[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)throw new PreviewError('无效的文件范围',416);start=Math.max(0,size-suffix);end=size-1;}
  else{start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),size-1):size-1;}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)throw new PreviewError('无效的文件范围',416);
  return {start,end,partial:true};
}
