const {app,BrowserWindow,Menu,Tray,nativeImage,ipcMain,dialog,shell,screen}=require('electron');
const path=require('node:path');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const {spawn}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const {createHash}=require('node:crypto');
const {pluginArchive}=require('./export.cjs');
const args=process.argv.slice(1);
const value=(key)=>{const i=args.indexOf(key);return i>=0?args[i+1]:undefined;};
const dataDir=path.resolve(value('--data')??path.join(process.env.LOCALAPPDATA??app.getPath('appData'),'TongpinObserver','data'));
const packagedFile=process.env.PORTABLE_EXECUTABLE_FILE??process.execPath;
const mcpMode=args.includes('--mcp-stdio');
const background=args.includes('--background');
let wantWindow=!background;
const profile=path.join(dataDir,'desktop-profile');
fs.mkdirSync(profile,{recursive:true});app.setPath('userData',profile);app.setName('同频');
let window,service,tray,mcpExecutable,quitting=false;
async function logError(error){await fsp.appendFile(path.join(dataDir,'desktop.log'),new Date().toISOString()+' '+String(error)+'\n','utf8').catch(()=>{});}
async function createWindow(){
  if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();return;}
  if(!service)return;
  const area=screen.getPrimaryDisplay().workAreaSize;
  window=new BrowserWindow({title:'同频 · 工作区观察器',width:Math.min(1440,area.width),height:Math.min(960,area.height),minWidth:900,minHeight:650,show:false,backgroundColor:'#ffffff',icon:path.join(app.getAppPath(),'assets','icon.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  const origin=`http://127.0.0.1:${service.port}`;
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==origin)event.preventDefault();});
  window.once('ready-to-show',()=>window.show());
  window.on('close',event=>{if(!quitting){event.preventDefault();window.hide();}});
  await window.loadURL(origin+'/');
}
function validSender(event){return window&&!window.isDestroyed()&&event.sender.id===window.webContents.id&&event.senderFrame?.url===`http://127.0.0.1:${service.port}/`;}
function setupIpc(){
  ipcMain.handle('tongpin:choose-folder',async(event)=>{
    if(!validSender(event))throw new Error('Invalid desktop sender');
    const result=await dialog.showOpenDialog(window,{title:'选择监控的项目文件夹',properties:['openDirectory']});
    return result.canceled?null:result.filePaths[0];
  });
  ipcMain.handle('tongpin:export-plugin',async(event,format,profileId)=>{
    if(!validSender(event)||!['mcpb','codex'].includes(format)||(profileId&&(!/^[0-9a-f-]{36}$/i.test(profileId)||!service.store.identity.profiles().some(p=>p.id===profileId&&!p.revoked))))throw new Error('Invalid plugin export request');
    if(!app.isPackaged)return {error:'请在打包后的 EXE 中导出插件。'};
    const extension=format==='mcpb'?'mcpb':'zip';
    const result=await dialog.showSaveDialog(window,{title:'导出本地 MCP 插件',defaultPath:path.join(app.getPath('downloads'),`同频-MCP-0.2.2.${extension}`),filters:[{name:format==='mcpb'?'MCP Bundle':'Codex 本地插件',extensions:[extension]}]});
    if(result.canceled||!result.filePath)return {cancelled:true};
    try{await fsp.writeFile(result.filePath,await pluginArchive(packagedFile,format,mcpExecutable,dataDir,profileId));return {path:result.filePath};}
    catch(e){await logError(e);return {error:'导出失败：'+e.message};}
  });
  ipcMain.handle('tongpin:reveal-data',async(event)=>{if(!validSender(event))throw new Error('Invalid desktop sender');await shell.openPath(dataDir);});
}
function createTray(){
  const icon=nativeImage.createFromPath(path.join(app.getAppPath(),'assets','icon.png')).resize({width:20,height:20});
  tray=new Tray(icon);tray.setToolTip('同频 · 文件监控与 MCP');
  tray.setContextMenu(Menu.buildFromTemplate([{label:'打开同频',click:()=>void createWindow()},{type:'separator'},{label:'退出同频',click:()=>app.quit()}]));
  tray.on('double-click',()=>void createWindow());
}
async function prepareMcpRuntime(){
  const source=app.isPackaged?path.join(process.resourcesPath,'mcp-helper.exe'):path.join(app.getAppPath(),'desktop-dist','mcp-helper.exe');
  const dir=path.join(dataDir,'mcp');await fsp.mkdir(dir,{recursive:true});
  mcpExecutable=path.join(dir,'Tongpin-MCP-0.2.2.exe');
  const fresh=await fsp.readFile(source);let identical=false;
  try{const old=await fsp.readFile(mcpExecutable);identical=createHash('sha256').update(old).digest('hex')===createHash('sha256').update(fresh).digest('hex');}catch{}
  if(!identical)await fsp.writeFile(mcpExecutable,fresh);
  let previous;try{previous=JSON.parse(await fsp.readFile(path.join(dataDir,'desktop-app.json'),'utf8'));}catch{}
  if(!background||!previous?.launcher||!fs.existsSync(previous.launcher))await fsp.writeFile(path.join(dataDir,'desktop-app.json'),JSON.stringify({launcher:app.isPackaged?packagedFile:process.execPath,version:'0.2.2'}),'utf8');
}
async function main(){
  if(args.includes('--self-test')){
    const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');
    const result={app:'Tongpin',version:'0.2.2',electron:process.versions.electron,node:process.versions.node,sqlite:db.prepare('select sqlite_version() AS version').get().version,packaged:app.isPackaged};db.close();
    process.stdout.write(JSON.stringify(result)+'\n');app.exit(0);return;
  }
  if(mcpMode){
    // Each client owns an independent STDIO connection. No UI singleton lock here.
    console.log=(...parts)=>console.error(...parts);
    await app.whenReady();
    const {runDesktopBridge}=await import(pathToFileURL(path.join(__dirname,'bridge.mjs')).href);
    await runDesktopBridge(dataDir,()=>{
      const command=app.isPackaged?packagedFile:process.execPath;
      const prefix=app.isPackaged?[]:[app.getAppPath()];
      const child=spawn(command,[...prefix,'--background','--data',dataDir],{detached:true,stdio:'ignore',windowsHide:true});
      child.on('error',e=>void logError(e));child.unref();
    },()=>app.exit(0),value('--client'));
    return;
  }
  if(!app.requestSingleInstanceLock({background,quit:args.includes('--shutdown')})){app.quit();return;}
  if(args.includes('--shutdown')){app.exit(0);return;}
  app.on('second-instance',(_event,_argv,_cwd,extra)=>{if(extra?.quit){app.quit();return;}if(!extra?.background){wantWindow=true;void createWindow();}});
  app.on('before-quit',event=>{
    if(quitting)return;
    event.preventDefault();quitting=true;
    Promise.resolve(service?.close()).catch(logError).finally(()=>{tray?.destroy();app.exit(0);});
  });
  app.on('window-all-closed',()=>{});
  await app.whenReady();
  await prepareMcpRuntime();
  const {startObserver}=await import(pathToFileURL(path.join(__dirname,'backend.mjs')).href);
  service=await startObserver({dataDir,port:0,root:value('--root'),runtimeCommand:{command:mcpExecutable,args:['--mcp-stdio','--data',dataDir]}});
  setupIpc();createTray();
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'同频',submenu:[{label:'打开主窗口',click:()=>void createWindow()},{label:'关闭后在托盘继续运行',enabled:false},{type:'separator'},{label:'退出同频',click:()=>app.quit()}]},{label:'编辑',submenu:[{role:'copy',label:'复制'},{role:'paste',label:'粘贴'},{role:'selectAll',label:'全选'}]}]));
  if(wantWindow)await createWindow();
  if(value('--quit-after'))setTimeout(()=>app.quit(),Number(value('--quit-after'))).unref();
  if(args.includes('--smoke-test')){
    await fsp.writeFile(path.join(dataDir,'desktop-smoke.json'),JSON.stringify({version:'0.2.2',packaged:app.isPackaged,node:process.versions.node,url:`http://127.0.0.1:${service.port}`,root:service.store.meta('active')?service.store.workspace().root:null,window:!background}),'utf8');
  }
}
main().catch(async error=>{await logError(error);if(mcpMode)console.error('同频 MCP 无法启动：'+error.message);else if(app.isReady())dialog.showErrorBox('同频启动失败',error.message);app.exit(1);});
