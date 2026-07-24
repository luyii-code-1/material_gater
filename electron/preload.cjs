const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('materialGater', {
  getState: () => ipcRenderer.invoke('state:get'),
  getDrives: () => ipcRenderer.invoke('drives:list'),
  chooseDirectory: (title) => ipcRenderer.invoke('dialog:directory', title),
  scan: (source) => ipcRenderer.invoke('media:scan', source),
  createLibrary: (options) => ipcRenderer.invoke('library:create', options),
  clearCatalog: () => ipcRenderer.invoke('catalog:clear'),
  openPath: (target) => ipcRenderer.invoke('path:open', target),
  onDrivesChanged: (callback) => {
    const listener = (_event, drives) => callback(drives);
    ipcRenderer.on('drives:changed', listener);
    return () => ipcRenderer.removeListener('drives:changed', listener);
  }
});
