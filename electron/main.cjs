const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { walkMedia, listDrives, createVirtualLibrary, summarize } = require('./core.cjs');

let mainWindow;
let catalog = { version: 1, files: [], lastScan: null, source: null };
let catalogPath;
let driveTimer;
let lastDriveSignature = '';

function resolveDataDirectory() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'MaterialGaterData');
  if (!app.isPackaged) return path.join(app.getAppPath(), 'portable-data');
  return path.join(app.getPath('userData'), 'data');
}

async function saveCatalog() {
  await fsp.mkdir(path.dirname(catalogPath), { recursive: true });
  const temp = `${catalogPath}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(catalog, null, 2));
  await fsp.rename(temp, catalogPath);
}

async function loadCatalog() {
  catalogPath = path.join(resolveDataDirectory(), 'catalog.json');
  try { catalog = JSON.parse(await fsp.readFile(catalogPath, 'utf8')); } catch { await saveCatalog(); }
}

function state() {
  return { catalog, stats: summarize(catalog.files), dataDirectory: path.dirname(catalogPath), platform: process.platform };
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240, height: 800, minWidth: 940, minHeight: 640,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0c0f12',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error('[renderer] load failed', { code, description, url });
  });
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[preload] failed', preloadPath, error);
  });
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) console.error('[renderer]', message, `${sourceId}:${line}`);
  });
  if (!app.isPackaged) await mainWindow.loadURL('http://127.0.0.1:5173');
  else await mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(async () => {
  await loadCatalog();
  await createWindow();
  driveTimer = setInterval(async () => {
    const drives = await listDrives();
    const signature = JSON.stringify(drives.map((drive) => drive.id).sort());
    if (signature !== lastDriveSignature) {
      lastDriveSignature = signature;
      mainWindow?.webContents.send('drives:changed', drives);
    }
  }, 4000);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => clearInterval(driveTimer));
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

ipcMain.handle('state:get', () => state());
ipcMain.handle('drives:list', () => listDrives());
ipcMain.handle('dialog:directory', async (_event, title) => {
  const result = await dialog.showOpenDialog(mainWindow, { title: title || '选择文件夹', properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('media:scan', async (_event, source) => {
  if (!source || !path.isAbsolute(source)) throw new Error('无效的素材目录');
  const files = await walkMedia(source);
  const existing = new Map(catalog.files.map((file) => [file.path, file]));
  for (const file of files) existing.set(file.path, file);
  catalog = { version: 1, files: [...existing.values()], lastScan: new Date().toISOString(), source };
  await saveCatalog();
  return state();
});
ipcMain.handle('library:create', async (_event, options) => createVirtualLibrary(catalog.files, options));
ipcMain.handle('catalog:clear', async () => {
  catalog = { version: 1, files: [], lastScan: null, source: null };
  await saveCatalog();
  return state();
});
ipcMain.handle('path:open', async (_event, target) => {
  if (!target || !path.isAbsolute(target)) return '无效路径';
  return shell.openPath(target);
});
