import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {zipSync,strToU8} from 'fflate';
import {startObserver} from '../server/http.ts';

async function setup(){
  const base=path.resolve('.work/test-runs');await fs.mkdir(base,{recursive:true});const dir=await fs.mkdtemp(path.join(base,'preview-'));
  const root=path.join(dir,'project'),data=path.join(dir,'data');await fs.mkdir(root);
  await fs.writeFile(path.join(root,'hello.txt'),'Hello 中文\nSecond line\n');await fs.writeFile(path.join(root,'table.csv'),'name,value,note\n"A, B",12,"line 1\nline 2"\n');
  await fs.writeFile(path.join(root,'data.json'),'{"count":12,"enabled":true}');await fs.writeFile(path.join(root,'picture.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="green"/></svg>');
  await fs.writeFile(path.join(root,'.env'),'excluded fixture');await fs.mkdir(path.join(root,'node_modules'));await fs.writeFile(path.join(root,'node_modules','hidden.txt'),'excluded');
  const service=await startObserver({dataDir:data,root,port:0});const id=service.store.workspace().id,url=`http://127.0.0.1:${service.port}`;
  const headers={Authorization:`Bearer ${service.token}`};
  const endpoint=(route:string,file='')=>`${url}/api/${route}?workspace_id=${id}&path=${encodeURIComponent(file)}`;
  const preview=async(file:string,extra='')=>{const response=await fetch(endpoint('preview',file)+extra,{headers});assert.equal(response.status,200);return response.json();};
  return {dir,root,service,id,url,headers,endpoint,preview};
}

test('preview API: real text/JSON/CSV, large-text prefix and explicit encoding',async()=>{
  const f=await setup();try{
    const text=await f.preview('hello.txt');assert.equal(text.kind,'text');assert.match(text.text,/中文/);assert.equal(text.encoding,'utf-8');
    const json=await f.preview('data.json');assert.match(json.text,/\n  "count": 12/);
    const csv=await f.preview('table.csv');assert.deepEqual(csv.rows[1],['A, B','12','line 1\nline 2']);
    await fs.writeFile(path.join(f.root,'large.log'),'大文本 '.repeat(400000));const large=await f.preview('large.log');assert.equal(large.kind,'text');assert.equal(large.truncated,true);assert.ok(large.text.length<=300000);assert.ok(!large.text.includes('\ufffd'));
    await fs.writeFile(path.join(f.root,'utf16.txt'),Buffer.from('UTF16 中文内容','utf16le'));const explicit=await f.preview('utf16.txt','&encoding=utf-16le');assert.match(explicit.text,/中文内容/);
    await fs.writeFile(path.join(f.root,'large.json'),JSON.stringify({text:'x'.repeat(2200000)}));const largeJson=await f.preview('large.json');assert.equal(largeJson.truncated,true);assert.ok(!largeJson.notices.some((s:string)=>s.includes('语法无效')));
  }finally{await f.service.close();}
});

test('preview boundaries: no credential files, traversal, drive/ADS paths or junction escape',async()=>{
  const f=await setup();try{
    const response=await fetch(f.endpoint('files'),{headers:f.headers});const listing=await response.json();assert.equal(response.status,200);assert.ok(!listing.entries.some((e:any)=>e.name==='.env'||e.name==='node_modules'));
    for(const file of ['../outside.txt','..\\outside.txt','C:\\Windows\\win.ini','/absolute','.env','node_modules/hidden.txt','hello.txt:private.txt'])assert.equal((await fetch(f.endpoint('preview',file),{headers:f.headers})).status,403,file);
    const outside=path.join(f.dir,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'outside.txt'),'outside fixture');await fs.symlink(outside,path.join(f.root,'escape'),process.platform==='win32'?'junction':'dir');
    assert.equal((await fetch(f.endpoint('preview','escape/outside.txt'),{headers:f.headers})).status,403);
    assert.equal((await fetch(f.endpoint('preview','hello.txt'))).status,401);
    assert.equal((await fetch(f.endpoint('preview','hello.txt'),{headers:{Authorization:`Bearer ${f.service.mcpToken}`}})).status,401);
    const newRoot=path.join(f.dir,'second');await fs.mkdir(newRoot);await f.service.monitor.select(newRoot);
    assert.equal((await fetch(f.endpoint('preview','hello.txt'),{headers:f.headers})).status,409,'stale workspace must not read the new root');
  }finally{await f.service.close();}
});

test('raw preview: exact byte ranges, HEAD, MIME and no executable/HTML delivery',async()=>{
  const f=await setup();try{
    const contents=await fs.readFile(path.join(f.root,'picture.svg'));
    const media=await f.preview('picture.svg');assert.equal(media.kind,'image');assert.match(media.content_url,/preview-content/);
    const partial=await fetch(f.endpoint('preview-content','picture.svg'),{headers:{...f.headers,Range:'bytes=0-4'}});assert.equal(partial.status,206);assert.equal(partial.headers.get('content-range'),`bytes 0-4/${contents.length}`);assert.equal(await partial.text(),contents.subarray(0,5).toString());
    const tail=await fetch(f.endpoint('preview-content','picture.svg'),{headers:{...f.headers,Range:'bytes=-6'}});assert.equal(await tail.text(),contents.subarray(-6).toString());
    const bad=await fetch(f.endpoint('preview-content','picture.svg'),{headers:{...f.headers,Range:'bytes=999999-'}});assert.equal(bad.status,416);assert.equal(bad.headers.get('content-range'),`bytes */${contents.length}`);
    const head=await fetch(f.endpoint('preview-content','picture.svg'),{method:'HEAD',headers:f.headers});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(contents.length));assert.equal(await head.text(),'');assert.match(head.headers.get('content-security-policy')!,/sandbox/);
    assert.equal((await fetch(f.endpoint('preview-content','hello.txt'),{headers:f.headers})).status,403);
    assert.equal((await fetch(f.endpoint('preview','missing.png'),{headers:f.headers})).status,404);
  }finally{await f.service.close();}
});

test('Office/ZIP content extraction and DTD/size limits; preview does not consume AI unread events',async()=>{
  const f=await setup();try{
    const xml=(s:string)=>strToU8(s);
    await fs.writeFile(path.join(f.root,'document.docx'),zipSync({'word/document.xml':xml('<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Word content</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>')}));
    const word=await f.preview('document.docx');assert.equal(word.kind,'word');assert.equal(word.blocks[0].text,'Word content');assert.equal(word.blocks[1].rows[0][0],'Cell A');
    await fs.writeFile(path.join(f.root,'book.xlsx'),zipSync({'xl/workbook.xml':xml('<workbook xmlns:r="urn:r"><sheets><sheet name="数据" r:id="rId1"/></sheets></workbook>'),'xl/_rels/workbook.xml.rels':xml('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),'xl/worksheets/sheet1.xml':xml('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Excel &#20013;&#25991;</t></is></c><c r="B1"><v>12.5</v></c><c r="C1"><f>SUM(B1:B2)</f></c></row></sheetData></worksheet>')}));
    const book=await f.preview('book.xlsx');assert.equal(book.kind,'spreadsheet');assert.deepEqual(book.sheets[0].rows[0],['Excel 中文','12.5','=SUM(B1:B2)']);
    await fs.writeFile(path.join(f.root,'slides.pptx'),zipSync({'ppt/slides/slide1.xml':xml('<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>Slide text</a:t></a:r></a:p></p:sld>')}));const slides=await f.preview('slides.pptx');assert.equal(slides.slides[0].paragraphs[0],'Slide text');
    await fs.writeFile(path.join(f.root,'unsafe.docx'),zipSync({'word/document.xml':xml('<!DOCTYPE x [<!ENTITY secret "no expansion">]><w:document xmlns:w="urn:w"><w:body/></w:document>')}));assert.equal((await f.preview('unsafe.docx')).kind,'unsupported');
    await fs.writeFile(path.join(f.root,'oversized.docx'),zipSync({'word/document.xml':xml('x'.repeat(4*1024*1024+1))}));assert.equal((await f.preview('oversized.docx')).kind,'unsupported');
    await fs.writeFile(path.join(f.root,'archive.zip'),zipSync({'a.txt':xml('archive content'),'../outside.txt':xml('list only')}));const archive=await f.preview('archive.zip');assert.equal(archive.kind,'archive');assert.equal(archive.entries.length,2);assert.ok(archive.entries.some((e:any)=>e.name==='../outside.txt'));
    const client=f.service.store.register(f.id,'reader');await fs.writeFile(path.join(f.root,'hello.txt'),'changed\n');await f.service.monitor.rescan();const before=f.service.store.changes(f.id,client.client_id);await f.preview('hello.txt');assert.deepEqual(f.service.store.changes(f.id,client.client_id).events,before.events);
  }finally{await f.service.close();}
});
