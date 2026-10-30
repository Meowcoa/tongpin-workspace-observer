import {unzipSync,strFromU8} from 'fflate';
import {XMLParser} from 'fast-xml-parser';
import path from 'node:path';
import type {OfficeBlock,PreviewSheet} from '../shared/preview-types.ts';

const LIMIT_XML=4*1024*1024,LIMIT_XML_TOTAL=16*1024*1024;
const options={ignoreAttributes:false,parseTagValue:false,parseAttributeValue:false,trimValues:false,processEntities:true,htmlEntities:true};
const normal=new XMLParser(options),ordered=new XMLParser({...options,preserveOrder:true});
type X = Record<string,any>;
const array=<T,>(value:T|T[]|undefined|null):T[]=>value==null?[]:Array.isArray(value)?value:[value];
function xmlText(bytes:Uint8Array){const text=strFromU8(bytes);if(/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text))throw new Error('不允许带 DTD 或实体声明的文档');return text;}
function textOf(value:any):string{if(value==null)return '';if(typeof value==='string'||typeof value==='number')return String(value);if(Array.isArray(value))return value.map(textOf).join('');return value['#text']!=null?String(value['#text']):'';}
function rich(value:X|undefined):string{return !value?'':value.t!=null?textOf(value.t):array<X>(value.r).map(r=>textOf(r.t)).join('');}
function find(nodes:X[],tag:string):X[][]{const found:X[][]=[];for(const node of nodes)for(const [key,value] of Object.entries(node)){if(key===tag&&Array.isArray(value))found.push(value);else if(key!==':@'&&Array.isArray(value))found.push(...find(value,tag));}return found;}
function runs(nodes:X[],prefix:string):string{let result='';for(const node of nodes)for(const [key,value] of Object.entries(node)){if(key===`${prefix}:t`)result+=array<X>(value).map(x=>textOf(x['#text'])).join('');else if(key===`${prefix}:br`)result+='\n';else if(key===`${prefix}:tab`)result+='\t';else if(key!==':@'&&Array.isArray(value))result+=runs(value,prefix);}return result;}

export function readOfficeParts(bytes:Uint8Array){
  let total=0,count=0;
  const parts=unzipSync(bytes,{filter:entry=>{
    if(++count>10000)throw new Error('压缩包条目过多');
    const wanted=/^(?:word\/document\.xml|ppt\/slides\/slide\d+\.xml|xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/sheet\d+\.xml))$/.test(entry.name);
    if(!wanted)return false;
    if(entry.originalSize>LIMIT_XML||(total+=entry.originalSize)>LIMIT_XML_TOTAL)throw new Error('Office 文本部分超过预览上限');
    return true;
  }});
  return parts;
}

export function wordPreview(parts:Record<string,Uint8Array>){
  if(!parts['word/document.xml'])throw new Error('未找到 Word 正文，可能是加密或不受支持的文档');
  const doc=ordered.parse(xmlText(parts['word/document.xml'])) as X[];
  const body=find(doc,'w:body')[0]??[];const blocks:OfficeBlock[]=[];let chars=0,truncated=false;
  for(const node of body){
    if(blocks.length>=500||chars>=150000){truncated=true;break;}
    if(node['w:p']){const text=runs(node['w:p'],'w');chars+=text.length;blocks.push({type:'paragraph',text:text.slice(0,20000)});if(text.length>20000)truncated=true;}
    else if(node['w:tbl']){
      const source=find(node['w:tbl'],'w:tr');if(source.length>200)truncated=true;
      const rows=source.slice(0,200).map(row=>find(row,'w:tc').slice(0,50).map(cell=>{const text=find(cell,'w:p').map(p=>runs(p,'w')).join('\n');chars+=text.length;return text.slice(0,3000);}));
      blocks.push({type:'table',rows});
    }
  }
  return {blocks,truncated};
}

export function presentationPreview(parts:Record<string,Uint8Array>){
  const paths=Object.keys(parts).filter(x=>/^ppt\/slides\/slide\d+\.xml$/.test(x)).sort((a,b)=>Number(a.match(/slide(\d+)/)![1])-Number(b.match(/slide(\d+)/)![1]));
  if(!paths.length)throw new Error('没有可读取的幻灯片');
  let chars=0,truncated=paths.length>100;
  const slides=[];
  for(const name of paths.slice(0,100)){
    if(chars>150000){truncated=true;break;}
    const doc=ordered.parse(xmlText(parts[name])) as X[];
    const all=find(doc,'a:p');if(all.length>200)truncated=true;
    const paragraphs=all.slice(0,200).map(p=>runs(p,'a').slice(0,10000)).filter(Boolean);
    chars+=paragraphs.join('').length;slides.push({number:Number(name.match(/slide(\d+)/)![1]),paragraphs});
  }
  return {slides,truncated};
}

function column(ref:string){const m=/^([A-Z]{1,3})[1-9]\d*$/.exec(ref);if(!m)return -1;let result=0;for(const c of m[1])result=result*26+c.charCodeAt(0)-64;return result-1;}
function dateCell(raw:string,date1904:boolean,withTime:boolean){const value=Number(raw);if(!Number.isFinite(value)||value<0||value>3652059)return raw;const offset=date1904?Date.UTC(1904,0,1):Date.UTC(1899,11,30)+(value<60?86400000:0);const result=new Date(offset+value*86400000).toISOString();return withTime?result.slice(0,19).replace('T',' '):result.slice(0,10);}
export function spreadsheetPreview(parts:Record<string,Uint8Array>){
  const read=(name:string)=>parts[name]?normal.parse(xmlText(parts[name])) as X:{};
  const book=read('xl/workbook.xml').workbook;if(!book)throw new Error('没有可读取的工作簿');
  const rels=array<X>(read('xl/_rels/workbook.xml.rels').Relationships?.Relationship);
  const strings=array<X>(read('xl/sharedStrings.xml').sst?.si).map(x=>rich(x));
  const styles=read('xl/styles.xml').styleSheet??{};
  const formats=new Map(array<X>(styles.numFmts?.numFmt).map(f=>[Number(f['@_numFmtId']),String(f['@_formatCode']??'')]));
  const xfs=array<X>(styles.cellXfs?.xf);
  const sourceSheets=array<X>(book.sheets?.sheet);let truncated=sourceSheets.length>20;
  const date1904=book.workbookPr?.['@_date1904']==='1'||book.workbookPr?.['@_date1904']==='true';
  const sheets:PreviewSheet[]=[];
  for(const sheet of sourceSheets.slice(0,20)){
    const rel=rels.find(r=>r['@_Id']===sheet['@_r:id']);if(!rel||rel['@_TargetMode']==='External')continue;
    const target=String(rel['@_Target']??'');
    const entry=target.startsWith('/')?target.slice(1):path.posix.normalize(path.posix.join('xl',target));
    if(!/^xl\/worksheets\/sheet\d+\.xml$/.test(entry)||!parts[entry])continue;
    const rowsIn=array<X>(read(entry).worksheet?.sheetData?.row);let clipped=rowsIn.length>200;
    const rows:string[][]=[],row_numbers:number[]=[];
    for(const row of rowsIn.slice(0,200)){
      const cells:string[]=[];
      for(const cell of array<X>(row.c)){
        const index=column(String(cell['@_r']??''));if(index<0)continue;if(index>=50){clipped=true;continue;}
        let value=textOf(cell.v);const type=cell['@_t'];
        if(type==='s')value=strings[Number(value)]??'（共享文本不可用）';
        else if(type==='inlineStr')value=rich(cell.is);
        else if(type==='b')value=value==='1'?'TRUE':'FALSE';
        else if(value!==''){
          const id=Number(xfs[Number(cell['@_s']??0)]?.['@_numFmtId']??0);
          const format=formats.get(id)?.replace(/"[^"]*"|\[[^\]]*\]/g,'')??'';
          if((id>=14&&id<=22)||/yy|dd|hh|ss|mm/i.test(format))value=dateCell(value,date1904,(id>=18&&id<=22)||/h|s/i.test(format));
        }
        if(value===''&&cell.f!=null)value='='+textOf(cell.f);
        if(value.length>5000){value=value.slice(0,5000);clipped=true;}cells[index]=value;
      }
      rows.push(Array.from({length:cells.length},(_,i)=>cells[i]??''));row_numbers.push(Number(row['@_r'])||rows.length);
    }
    sheets.push({name:String(sheet['@_name']??`Sheet ${sheets.length+1}`),rows,row_numbers,truncated:clipped});truncated||=clipped;
  }
  if(!sheets.length)throw new Error('没有可预览的工作表');return {sheets,truncated};
}
