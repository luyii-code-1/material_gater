const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('materialGater', {
  getState: () => ipcRenderer.invoke('state:get'),
  getDrives: () => ipcRenderer.invoke('drives:list'),
  chooseDirectory: (title) => ipcRenderer.invoke('dialog:directory', title),
  scan: (source) => ipcRenderer.invoke('media:scan', source),
  listDirectory: (root, relative) => ipcRenderer.invoke('directory:list', root, relative),
  openMedia: (target) => ipcRenderer.invoke('media:open', target),
  revealMedia: (target) => ipcRenderer.invoke('media:reveal', target),
  showMediaMenu: (target) => ipcRenderer.invoke('media:context-menu', target),
  createLibrary: (options) => ipcRenderer.invoke('library:create', options),
  saveMapping: (mapping) => ipcRenderer.invoke('mapping:save', mapping),
  runMapping: (id) => ipcRenderer.invoke('mapping:run', id),
  deleteMapping: (request) => ipcRenderer.invoke('mapping:delete', request),
  saveRepository: (repository) => ipcRenderer.invoke('repository:save', repository),
  testRepository: (repository) => ipcRenderer.invoke('repository:test', repository),
  deleteRepository: (id) => ipcRenderer.invoke('repository:delete', id),
  savePreset: (preset) => ipcRenderer.invoke('preset:save', preset),
  deletePreset: (id) => ipcRenderer.invoke('preset:delete', id),
  createCopyTask: (input) => ipcRenderer.invoke('copy:create', input),
  pauseCopyTask: (id) => ipcRenderer.invoke('copy:pause', id),
  resumeCopyTask: (id) => ipcRenderer.invoke('copy:resume', id),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  clearCatalog: () => ipcRenderer.invoke('catalog:clear'),
  openPath: (target) => ipcRenderer.invoke('path:open', target),
  onDrivesChanged: (callback) => {
    const listener = (_event, drives) => callback(drives);
    ipcRenderer.on('drives:changed', listener);
    return () => ipcRenderer.removeListener('drives:changed', listener);
  },
  onDriveIo: (callback) => {
    const listener = (_event, speeds) => callback(speeds);
    ipcRenderer.on('drives:io', listener);
    return () => ipcRenderer.removeListener('drives:io', listener);
  },
  onStateChanged: (callback) => {
    const listener = (_event, next) => callback(next);
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  },
  onCopyChanged: (callback) => {
    const listener = (_event, tasks) => callback(tasks);
    ipcRenderer.on('copy:changed', listener);
    return () => ipcRenderer.removeListener('copy:changed', listener);
  },
  onSourceRemoved: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('source:removed', listener);
    return () => ipcRenderer.removeListener('source:removed', listener);
  },
  onScanCompleted: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('scan:completed', listener);
    return () => ipcRenderer.removeListener('scan:completed', listener);
  }
});
