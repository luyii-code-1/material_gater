const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu, safeStorage } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { walkMedia, listDirectory, listDrives, sampleDriveIo, createVirtualLibrary, cleanupVirtualLibrary, summarize } = require('./core.cjs');
const { CopyManager } = require('./copy-engine.cjs');
const { createRepositorySession } = require('./repository-connectors.cjs');

const DEFAULT_SETTINGS = { foregroundScanMs: 1000, backgroundScanMs: 3000, askBeforeScan: true, notifications: true, keepRunning: true };
let mainWindow;
let quitting = false;
let catalog = { version: 4, files: [], sources: [], mappings: [], repositories: [], presets: [], tasks: [], settings: { ...DEFAULT_SETTINGS }, lastScan: null, source: null };
let catalogPath;
let vaultPath;
let vault = {};
let driveTimer;
let ioTimer;
let currentDrives = [];
let lastDriveSignature = '';
let sourceWatchers = new Map();
let scanDebounces = new Map();
let pendingPrompts = new Set();
let copyManager;
let copyStatuses = new Map();

function resolveDataDirectory() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'MaterialGaterData');
  if (!app.isPackaged) return path.join(app.getAppPath(), 'portable-data');
  return path.join(app.getPath('userData'), 'data');
}

async function atomicWrite(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value, null, 2));
  await fsp.rename(temp, file);
}

async function saveCatalog() { await atomicWrite(catalogPath, catalog); }
async function saveVault() { await atomicWrite(vaultPath, vault); }

function migrateCatalog(stored) {
  const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  const sources = Array.isArray(stored.sources) ? stored.sources : [];
  return {
    version: 4,
    files: Array.isArray(stored.files) ? stored.files : [],
    sources,
    mappings: Array.isArray(stored.mappings) ? stored.mappings.map((mapping) => ({ ...mapping, source: mapping.source || stored.source || '', sourceUuid: mapping.sourceUuid || '' })) : [],
    repositories: Array.isArray(stored.repositories) ? stored.repositories : [],
    presets: Array.isArray(stored.presets) ? stored.presets : [],
    tasks: Array.isArray(stored.tasks) ? stored.tasks : [],
    settings,
    lastScan: stored.lastScan || null,
    source: stored.source || null
  };
}

async function loadCatalog() {
  const dataDirectory = resolveDataDirectory();
  catalogPath = path.join(dataDirectory, 'catalog.json');
  vaultPath = path.join(dataDirectory, 'vault.json');
  try { catalog = migrateCatalog(JSON.parse(await fsp.readFile(catalogPath, 'utf8'))); } catch { catalog = migrateCatalog({}); }
  try { vault = JSON.parse(await fsp.readFile(vaultPath, 'utf8')); } catch { vault = {}; }
  await saveCatalog();
}

function onlineUuids() { return new Set([...currentDrives.map((drive) => drive.uuid), ...catalog.sources.filter((source) => source.online).map((source) => source.uuid)]); }
function publicRepository(repository) { const { credentialKey: _credentialKey, ...publicValues } = repository; return { ...publicValues, hasPassword: Boolean(vault[repository.id]) }; }
function state() {
  const online = onlineUuids();
  const onlinePaths = new Set([
    ...currentDrives.map((drive) => drive.path),
    ...catalog.sources.filter((source) => source.online).map((source) => source.lastPath)
  ]);
  const files = catalog.files.filter((file) => file.sourceUuid ? online.has(file.sourceUuid) : onlinePaths.has(file.source));
  return {
    catalog: { ...catalog, files, repositories: catalog.repositories.map(publicRepository), tasks: copyManager ? copyManager.snapshot() : catalog.tasks },
    stats: summarize(files), dataDirectory: path.dirname(catalogPath), platform: process.platform
  };
}

function send(channel, payload) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload); }
function broadcastState() { send('state:changed', state()); }

async function ensureWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  await createWindow();
  return mainWindow;
}

async function showMainWindow() {
  const window = await ensureWindow();
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320, height: 840, minWidth: 1050, minHeight: 680,
    titleBarStyle: 'default',
    backgroundColor: '#0c0f12',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  mainWindow.on('close', (event) => {
    if (!quitting && catalog.settings.keepRunning) { event.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('show', scheduleDrivePoll);
  mainWindow.on('hide', scheduleDrivePoll);
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => console.error('[renderer] load failed', { code, description, url }));
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => console.error('[preload] failed', preloadPath, error));
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => { if (level >= 2) console.error('[renderer]', message, `${sourceId}:${line}`); });
  if (!app.isPackaged) await mainWindow.loadURL('http://127.0.0.1:5173');
  else await mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

function notify(title, body, onClick) {
  if (!catalog.settings.notifications || !Notification.isSupported()) return null;
  const notification = new Notification({ title, body, silent: false });
  if (onClick) notification.on('click', onClick);
  notification.show();
  return notification;
}

function currentInterval() {
  return mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()
    ? catalog.settings.foregroundScanMs : catalog.settings.backgroundScanMs;
}

function scheduleDrivePoll() {
  clearTimeout(driveTimer);
  driveTimer = setTimeout(async () => {
    try { await pollDrives(); }
    catch (error) { console.error('[drives] poll failed', error); }
    finally { scheduleDrivePoll(); }
  }, Math.max(500, currentInterval()));
}

async function refreshSourcePaths(drive) {
  const source = catalog.sources.find((item) => item.uuid === drive.uuid);
  const previousPath = source?.lastPath;
  if (source) Object.assign(source, { name: drive.name, lastPath: drive.path, lastSeen: new Date().toISOString(), online: true });
  else catalog.sources.push({ uuid: drive.uuid, name: drive.name, lastPath: drive.path, lastSeen: new Date().toISOString(), online: true, external: drive.kind === '目录' });
  for (const file of catalog.files) if (!file.sourceUuid && file.source === drive.path) file.sourceUuid = drive.uuid;
  if (previousPath && previousPath !== drive.path) {
    catalog.files.filter((file) => file.sourceUuid === drive.uuid).forEach((file) => { file.source = drive.path; file.path = path.join(drive.path, file.relativePath); });
  }
  for (const mapping of catalog.mappings) {
    if (!mapping.sourceUuid && mapping.source === drive.path) mapping.sourceUuid = drive.uuid;
    if (mapping.sourceUuid === drive.uuid) mapping.source = drive.path;
  }
}

async function scanDrive(drive, quiet = false) {
  if (!drive || !(await fsp.stat(drive.path).catch(() => null))) return state();
  const files = (await walkMedia(drive.path)).map((file) => ({ ...file, sourceUuid: drive.uuid }));
  catalog.files = [...catalog.files.filter((file) => file.sourceUuid !== drive.uuid && file.source !== drive.path), ...files];
  catalog.lastScan = new Date().toISOString(); catalog.source = drive.path;
  await refreshSourcePaths(drive); await saveCatalog(); installSourceWatcher(drive); broadcastState();
  if (!quiet) send('scan:completed', { uuid: drive.uuid, name: drive.name, count: files.length });
  return state();
}

function installSourceWatcher(drive) {
  sourceWatchers.get(drive.uuid)?.close();
  try {
    const watcher = fs.watch(drive.path, { recursive: true }, () => {
      clearTimeout(scanDebounces.get(drive.uuid));
      scanDebounces.set(drive.uuid, setTimeout(() => void scanDrive(drive, true), 900));
    });
    watcher.on('error', () => watcher.close()); sourceWatchers.set(drive.uuid, watcher);
  } catch { /* volume may not support watching */ }
}

async function mountMappings(drive) {
  const files = catalog.files.filter((file) => file.sourceUuid === drive.uuid);
  for (const mapping of catalog.mappings.filter((item) => item.sourceUuid === drive.uuid)) {
    if (!files.length) continue;
    try {
      const result = await createVirtualLibrary(files, mapping);
      mapping.mounted = true; mapping.lastRun = { at: new Date().toISOString(), total: result.total, linked: result.linked, failed: result.failures.length };
    } catch (error) { mapping.mounted = false; mapping.mountError = error.message; }
  }
}

async function unmountMappings(drive) {
  let removed = 0;
  for (const mapping of catalog.mappings.filter((item) => item.sourceUuid === drive.uuid || item.source === drive.path)) {
    const result = await cleanupVirtualLibrary(mapping.destination, mapping.id).catch(() => null);
    removed += result?.removed || 0; mapping.mounted = false;
  }
  return removed;
}

async function askToScan(drive) {
  if (!catalog.settings.askBeforeScan || pendingPrompts.has(drive.uuid)) return;
  pendingPrompts.add(drive.uuid);
  const prompt = async () => {
    await showMainWindow();
    const result = await dialog.showMessageBox(mainWindow, { type: 'question', buttons: ['扫描素材', '稍后'], defaultId: 0, cancelId: 1, title: '检测到素材盘', message: `检测到“${drive.name}”`, detail: '是否立即扫描并刷新素材库？' });
    pendingPrompts.delete(drive.uuid);
    if (result.response === 0) await scanDrive(currentDrives.find((item) => item.uuid === drive.uuid) || drive);
  };
  if (mainWindow?.isVisible() && mainWindow?.isFocused()) await prompt();
  else {
    const shown = notify('检测到素材盘', `${drive.name} 已连接，点击选择是否扫描`, () => void prompt());
    if (!shown) pendingPrompts.delete(drive.uuid);
  }
}

async function handleAdded(drive) {
  await refreshSourcePaths(drive); await mountMappings(drive); installSourceWatcher(drive); await saveCatalog();
  notify('素材源已连接', `${drive.name} 已连接，已有映射已恢复`);
  broadcastState(); void askToScan(drive);
}

async function handleRemoved(drive) {
  sourceWatchers.get(drive.uuid)?.close(); sourceWatchers.delete(drive.uuid);
  const source = catalog.sources.find((item) => item.uuid === drive.uuid); if (source) source.online = false;
  const removed = await unmountMappings(drive); await saveCatalog();
  notify('素材源已移除', `${drive.name} 已移除${removed ? `，${removed} 个映射链接已卸载` : ''}`);
  send('source:removed', { ...drive, removedLinks: removed }); broadcastState();
}

async function pollDrives(initial = false) {
  const next = await listDrives();
  const signature = JSON.stringify(next.map((drive) => [drive.uuid, drive.path, drive.name]).sort());
  const previousMap = new Map(currentDrives.map((drive) => [drive.uuid, drive]));
  const nextMap = new Map(next.map((drive) => [drive.uuid, drive]));
  currentDrives = next;
  const removed = [...previousMap.values()].filter((drive) => !nextMap.has(drive.uuid));
  const added = next.filter((drive) => !previousMap.has(drive.uuid));
  for (const source of catalog.sources) source.online = Boolean(source.external || nextMap.has(source.uuid));
  if (!initial) for (const drive of removed) await handleRemoved(drive);
  for (const drive of added) await handleAdded(drive);
  if (signature !== lastDriveSignature) { lastDriveSignature = signature; send('drives:changed', currentDrives); }
}

function validateMapping(input) {
  if (!input || typeof input !== 'object') throw new Error('映射配置无效');
  if (!input.source || !path.isAbsolute(input.source)) throw new Error('请选择有效的素材来源');
  if (!input.destination || !path.isAbsolute(input.destination)) throw new Error('请选择有效的输出目录');
  const drive = currentDrives.find((item) => item.uuid === input.sourceUuid || item.path === input.source);
  return {
    name: String(input.name || '未命名映射').trim().slice(0, 80) || '未命名映射', source: path.resolve(input.source),
    sourceUuid: input.sourceUuid || drive?.uuid || '', destination: path.resolve(input.destination),
    extensions: Array.isArray(input.extensions) ? [...new Set(input.extensions.map((item) => String(item).toLowerCase()))] : [],
    startDate: input.startDate || '', endDate: input.endDate || ''
  };
}

function validateRepository(input) {
  const type = ['local', 'usb', 'smb', 'ftp', 'sftp'].includes(input?.type) ? input.type : 'local';
  if (!input?.name?.trim()) throw new Error('请输入储存库名称');
  if (['local', 'usb'].includes(type) && (!input.root || !path.isAbsolute(input.root))) throw new Error('请选择储存库目录');
  if (['smb', 'ftp', 'sftp'].includes(type) && !input.address?.trim()) throw new Error('请输入远程地址');
  return { name: input.name.trim().slice(0, 80), type, root: input.root || '', address: input.address?.trim() || '', remotePath: input.remotePath?.trim() || '', username: input.username?.trim() || '', domain: input.domain?.trim() || '', port: Number(input.port || 0) || null };
}

async function storePassword(id, password) {
  if (!password) return;
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，未保存密码');
  vault[id] = safeStorage.encryptString(password).toString('base64'); await saveVault();
}

function readPassword(id) {
  if (!vault[id] || !safeStorage.isEncryptionAvailable()) return '';
  try { return safeStorage.decryptString(Buffer.from(vault[id], 'base64')); } catch { return ''; }
}

app.whenReady().then(async () => {
  await loadCatalog();
  copyManager = new CopyManager({
    tasks: catalog.tasks,
    persist: async (tasks) => { catalog.tasks = tasks; await saveCatalog(); },
    resolveRepository: (id) => catalog.repositories.find((item) => item.id === id),
    createSession: (repository) => createRepositorySession(repository, readPassword(repository.id))
  });
  copyStatuses = new Map(copyManager.snapshot().map((task) => [task.id, task.status]));
  copyManager.on('changed', (tasks) => {
    catalog.tasks = tasks; send('copy:changed', tasks);
    for (const task of tasks) {
      const previous = copyStatuses.get(task.id);
      if (previous && previous !== task.status && task.status === 'completed') notify('拷贝完成', `${task.name} · ${task.files.length} 个文件`);
      if (previous && previous !== task.status && task.status === 'failed') notify('拷贝任务失败', `${task.name} · ${task.error || '请打开应用查看'}`);
      copyStatuses.set(task.id, task.status);
    }
  });
  await createWindow();
  await pollDrives(false); scheduleDrivePoll();
  ioTimer = setInterval(async () => send('drives:io', await sampleDriveIo(currentDrives)), 1000);
});

app.on('window-all-closed', () => { if (!catalog.settings.keepRunning && process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { quitting = true; clearTimeout(driveTimer); clearInterval(ioTimer); for (const watcher of sourceWatchers.values()) watcher.close(); });
app.on('activate', () => void showMainWindow());

ipcMain.handle('state:get', () => state());
ipcMain.handle('drives:list', () => currentDrives);
ipcMain.handle('dialog:directory', async (_event, title) => { const result = await dialog.showOpenDialog(mainWindow, { title: title || '选择文件夹', properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? null : result.filePaths[0]; });
ipcMain.handle('media:scan', async (_event, source) => { const drive = currentDrives.find((item) => item.path === source) || { id: source, uuid: source, name: path.basename(source), path: source, kind: '目录' }; return scanDrive(drive); });
ipcMain.handle('directory:list', (_event, root, relative) => listDirectory(root, relative));
ipcMain.handle('media:open', async (_event, target) => path.isAbsolute(target) ? shell.openPath(target) : '无效路径');
ipcMain.handle('media:reveal', (_event, target) => { if (path.isAbsolute(target)) shell.showItemInFolder(target); });
ipcMain.handle('media:context-menu', (_event, target) => { if (!path.isAbsolute(target)) return; Menu.buildFromTemplate([{ label: '打开', click: () => void shell.openPath(target) }, { label: '打开文件所在位置', click: () => shell.showItemInFolder(target) }]).popup({ window: mainWindow }); });
ipcMain.handle('library:create', async (_event, options) => createVirtualLibrary(catalog.files, options));
ipcMain.handle('mapping:save', async (_event, input) => {
  const values = validateMapping(input); const now = new Date().toISOString(); const index = input.id ? catalog.mappings.findIndex((item) => item.id === input.id) : -1;
  const mapping = index >= 0 ? { ...catalog.mappings[index], ...values, updatedAt: now } : { id: crypto.randomUUID(), ...values, createdAt: now, updatedAt: now, lastRun: null, mounted: false };
  if (index >= 0) catalog.mappings[index] = mapping; else catalog.mappings.push(mapping); await saveCatalog(); return { state: state(), mapping };
});
ipcMain.handle('mapping:run', async (_event, id) => {
  const mapping = catalog.mappings.find((item) => item.id === id); if (!mapping) throw new Error('找不到该映射');
  const files = catalog.files.filter((file) => mapping.sourceUuid ? file.sourceUuid === mapping.sourceUuid : file.source === mapping.source); if (!files.length) throw new Error('该来源尚未建立索引');
  const result = await createVirtualLibrary(files, mapping); mapping.mounted = true; mapping.lastRun = { at: new Date().toISOString(), total: result.total, linked: result.linked, failed: result.failures.length }; await saveCatalog(); return { state: state(), result };
});
ipcMain.handle('mapping:delete', async (_event, request) => { const mapping = catalog.mappings.find((item) => item.id === request?.id); if (!mapping) throw new Error('找不到该映射'); const cleanup = request.cleanup ? await cleanupVirtualLibrary(mapping.destination, mapping.id) : null; catalog.mappings = catalog.mappings.filter((item) => item.id !== mapping.id); await saveCatalog(); return { state: state(), cleanup }; });
ipcMain.handle('repository:save', async (_event, input) => { const values = validateRepository(input); const index = input.id ? catalog.repositories.findIndex((item) => item.id === input.id) : -1; const repository = index >= 0 ? { ...catalog.repositories[index], ...values } : { id: crypto.randomUUID(), ...values, createdAt: new Date().toISOString() }; if (index >= 0) catalog.repositories[index] = repository; else catalog.repositories.push(repository); await storePassword(repository.id, input.password); await saveCatalog(); return state(); });
ipcMain.handle('repository:test', async (_event, input) => {
  const repository = { id: input.id || 'test', ...validateRepository(input) };
  if (['local', 'usb'].includes(repository.type) || repository.root) {
    await fsp.access(repository.root, fs.constants.R_OK | fs.constants.W_OK);
    return { ok: true, message: '目录可读写' };
  }
  const session = await createRepositorySession(repository, input.password || readPassword(repository.id));
  await session.close();
  return { ok: true, message: `${repository.type.toUpperCase()} 连接成功` };
});
ipcMain.handle('repository:delete', async (_event, id) => { catalog.repositories = catalog.repositories.filter((item) => item.id !== id); delete vault[id]; await Promise.all([saveCatalog(), saveVault()]); return state(); });
ipcMain.handle('preset:save', async (_event, input) => { const preset = { ...input, id: input.id || crypto.randomUUID(), updatedAt: new Date().toISOString() }; const index = catalog.presets.findIndex((item) => item.id === preset.id); if (index >= 0) catalog.presets[index] = preset; else catalog.presets.push(preset); await saveCatalog(); return state(); });
ipcMain.handle('copy:create', async (_event, input) => { const files = catalog.files.filter((file) => file.sourceUuid === input.sourceUuid); const task = await copyManager.create(input, files); return { state: state(), task }; });
ipcMain.handle('copy:pause', async (_event, id) => { await copyManager.pause(id); return state(); });
ipcMain.handle('copy:resume', async (_event, id) => { void copyManager.resume(id); return state(); });
ipcMain.handle('settings:save', async (_event, values) => { catalog.settings = { ...catalog.settings, ...values, foregroundScanMs: Math.max(500, Number(values.foregroundScanMs) || 1000), backgroundScanMs: Math.max(1000, Number(values.backgroundScanMs) || 3000) }; await saveCatalog(); scheduleDrivePoll(); return state(); });
ipcMain.handle('catalog:clear', async () => { catalog.files = []; catalog.lastScan = null; catalog.source = null; await saveCatalog(); broadcastState(); return state(); });
ipcMain.handle('path:open', async (_event, target) => path.isAbsolute(target) ? shell.openPath(target) : '无效路径');
ipcMain.handle('window:show', () => showMainWindow());
