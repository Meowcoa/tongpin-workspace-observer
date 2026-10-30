const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tongpinDesktop',Object.freeze({
  chooseFolder:()=>ipcRenderer.invoke('tongpin:choose-folder'),
  exportPlugin:(format,profileId)=>ipcRenderer.invoke('tongpin:export-plugin',format,profileId),
  revealData:()=>ipcRenderer.invoke('tongpin:reveal-data')
}));
