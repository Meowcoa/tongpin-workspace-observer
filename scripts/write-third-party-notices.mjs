import {promises as fs} from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),lock=JSON.parse(await fs.readFile(path.join(root,'package-lock.json'),'utf8'));
const sections=['Tongpin third-party notices\nGenerated from package-lock.json and the installed dependency license files.\nProject code: MIT; third-party components retain their own licenses.'];
let count=0;
async function licenses(directory,label,declared){
  let files;try{files=await fs.readdir(directory);}catch(e){if(e.code==='ENOENT')return;throw e;}
  const selected=files.filter(name=>/^(licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(name));
  if(!selected.length)return;
  sections.push(`\n===== ${label} (${declared??'see included license'}) =====\n`);
  for(const name of selected){const file=path.join(directory,name);if((await fs.stat(file)).isFile())sections.push(`--- ${name} ---\n`+await fs.readFile(file,'utf8'));}
  count++;
}
for(const [relative,info] of Object.entries(lock.packages)){
  if(!relative.startsWith('node_modules/')||info.dev===true)continue;
  await licenses(path.join(root,relative),`${info.name??relative.split('node_modules/').at(-1)}@${info.version}`,typeof info.license==='string'?info.license:undefined);
}
await licenses(path.join(root,'node_modules','pdfjs-dist','standard_fonts'),'PDF.js standard fonts');
await licenses(path.join(root,'node_modules','pdfjs-dist','cmaps'),'PDF.js character maps');
await licenses(path.join(root,'node_modules','electron'),'Electron','MIT');
const nodeSource=JSON.parse(await fs.readFile(path.join(root,'third_party','nodejs','source.json'),'utf8'));
if(process.versions.node!==nodeSource.version)throw new Error(`Desktop builds require Node.js ${nodeSource.version} from .nvmrc; refresh the pinned runtime license when upgrading Node.`);
sections.push(`\n===== Node.js ${nodeSource.version} and bundled components =====\n`+await fs.readFile(path.join(root,'third_party','nodejs','LICENSE'),'utf8'));
await fs.mkdir(path.join(root,'release'),{recursive:true});
await fs.writeFile(path.join(root,'release','THIRD_PARTY_LICENSES.txt'),sections.join('\n'),'utf8');
console.log(`Collected installed production/runtime license notices (${count} sections).`);
