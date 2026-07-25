const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

function localDay(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function localTime(value) {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, '0')}-${String(date.getMinutes()).padStart(2, '0')}-${String(date.getSeconds()).padStart(2, '0')}`;
}

function safeSegment(value) {
  return String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
}

function expandPathTemplate(template, file, note = '') {
  const fallback = '%day/%note';
  const source = String(template || fallback)
    .replace(/%note\("([^"]*)"\)/g, (_match, inline) => safeSegment(inline))
    .replace(/%day/g, localDay(file.capturedAt))
    .replace(/%time/g, localTime(file.capturedAt))
    .replace(/%note/g, safeSegment(note));
  const parts = source.split(/[\\/]+/).map(safeSegment).filter(Boolean);
  return parts.join(path.sep);
}

function selectFiles(files, selection = {}) {
  const ids = new Set(selection.fileIds || []);
  const extensions = new Set((selection.extensions || []).map((item) => String(item).toLowerCase()));
  const start = selection.startDate ? new Date(`${selection.startDate}T00:00:00`) : null;
  const end = selection.endDate ? new Date(`${selection.endDate}T23:59:59.999`) : null;
  return files.filter((file) => {
    const date = new Date(file.capturedAt);
    return (!ids.size || ids.has(file.id)) && (!extensions.size || extensions.has(file.extension))
      && (!start || date >= start) && (!end || date <= end);
  });
}

async function copyFileResumable(source, destination, onProgress = () => {}, signal) {
  const sourceStat = await fsp.stat(source);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const finalStat = await fsp.stat(destination).catch(() => null);
  if (finalStat?.size === sourceStat.size) return { copied: sourceStat.size, skipped: true };
  const partial = `${destination}.material-gater.part`;
  let offset = (await fsp.stat(partial).catch(() => null))?.size || 0;
  if (offset > sourceStat.size) { await fsp.truncate(partial, 0); offset = 0; }
  const reader = await fsp.open(source, 'r');
  const writer = await fsp.open(partial, offset ? 'r+' : 'w');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    while (offset < sourceStat.size) {
      if (signal?.aborted) throw new Error('任务已暂停');
      const { bytesRead } = await reader.read(buffer, 0, Math.min(buffer.length, sourceStat.size - offset), offset);
      if (!bytesRead) break;
      await writer.write(buffer, 0, bytesRead, offset);
      offset += bytesRead;
      onProgress(bytesRead, offset, sourceStat.size);
    }
    await writer.sync();
  } finally { await reader.close(); await writer.close(); }
  if (offset !== sourceStat.size) throw new Error('文件读取未完成');
  await fsp.rm(destination, { force: true });
  await fsp.rename(partial, destination);
  return { copied: offset, skipped: false };
}

class CopyManager extends EventEmitter {
  constructor(options) {
    super();
    this.tasks = options.tasks || [];
    this.persist = options.persist || (async () => {});
    this.resolveRepository = options.resolveRepository;
    this.createSession = options.createSession || (async (repository) => ({ copy: (source, relative, progress, signal) => copyFileResumable(source, path.join(repository.root, relative), progress, signal), close: async () => {} }));
    this.controllers = new Map();
    for (const task of this.tasks) if (task.status === 'running') task.status = 'paused';
  }

  snapshot() { return this.tasks.map((task) => ({ ...task, files: task.files.map((file) => ({ ...file })) })); }

  async create(input, sourceFiles) {
    const selected = selectFiles(sourceFiles, input.selection);
    if (!selected.length) throw new Error('没有选择需要拷贝的素材');
    const repository = this.resolveRepository(input.repositoryId);
    if (!repository) throw new Error('找不到目标储存库');
    if (['local', 'usb'].includes(repository.type) && (!repository.root || !path.isAbsolute(repository.root))) throw new Error('储存库目录无效');
    const used = new Map();
    const items = selected.map((file) => {
      const folder = expandPathTemplate(input.pathTemplate, file, input.note);
      let relative = input.mode === 'original' ? path.join(folder, file.relativePath) : path.join(folder, file.name);
      const key = relative.toLowerCase();
      const count = used.get(key) || 0; used.set(key, count + 1);
      if (count) {
        const ext = path.extname(relative); relative = `${relative.slice(0, -ext.length)}-${count + 1}${ext}`;
      }
      return { id: crypto.randomUUID(), source: file.path, relative, size: file.size, copied: 0, status: 'queued', error: '' };
    });
    const task = {
      id: crypto.randomUUID(), name: input.name || `拷贝 ${localDay(new Date())}`, repositoryId: repository.id,
      sourceUuid: input.sourceUuid, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      totalBytes: items.reduce((sum, item) => sum + item.size, 0), copiedBytes: 0, speed: 0, eta: null,
      history: [], files: items, pathTemplate: input.pathTemplate, note: input.note || '', mode: input.mode || 'flat'
    };
    this.tasks.unshift(task); await this.persist(this.tasks); this.emit('changed', this.snapshot());
    void this.start(task.id);
    return task;
  }

  async start(id) {
    const task = this.tasks.find((item) => item.id === id);
    if (!task || task.status === 'running' || task.status === 'completed') return;
    const repository = this.resolveRepository(task.repositoryId);
    if (!repository) {
      task.status = 'failed'; task.error = '储存库已被删除'; task.updatedAt = new Date().toISOString();
      await this.persist(this.tasks); this.emit('changed', this.snapshot());
      return;
    }
    const controller = new AbortController(); this.controllers.set(id, controller);
    task.status = 'running'; task.error = ''; task.updatedAt = new Date().toISOString();
    let windowBytes = 0; let windowStarted = Date.now(); let lastPersist = 0;
    const tick = async (bytes) => {
      task.copiedBytes += bytes; windowBytes += bytes;
      const now = Date.now(); const elapsed = (now - windowStarted) / 1000;
      if (elapsed >= 0.5) {
        task.speed = windowBytes / elapsed;
        task.eta = task.speed > 0 ? Math.ceil((task.totalBytes - task.copiedBytes) / task.speed) : null;
        task.history.push(task.speed); task.history = task.history.slice(-80);
        windowBytes = 0; windowStarted = now;
        this.emit('changed', this.snapshot());
      }
      if (now - lastPersist > 1500) { lastPersist = now; await this.persist(this.tasks); }
    };
    let session;
    try {
      session = await this.createSession(repository);
      for (const file of task.files) {
        if (controller.signal.aborted) break;
        if (file.status === 'completed') continue;
        file.status = 'copying';
        const previous = file.copied;
        const result = await session.copy(file.source, file.relative, (bytes, copied) => { file.copied = copied; void tick(bytes); }, controller.signal);
        if (result.skipped) task.copiedBytes += Math.max(0, file.size - previous);
        file.copied = file.size; file.status = 'completed'; file.error = '';
      }
      if (controller.signal.aborted) task.status = 'paused';
      else { task.status = 'completed'; task.speed = 0; task.eta = 0; task.copiedBytes = task.totalBytes; }
    } catch (error) {
      if (controller.signal.aborted) task.status = 'paused';
      else { task.status = 'failed'; task.error = error.message; const active = task.files.find((file) => file.status === 'copying'); if (active) { active.status = 'failed'; active.error = error.message; } }
    } finally {
      await session?.close().catch(() => {});
      task.updatedAt = new Date().toISOString(); this.controllers.delete(id); await this.persist(this.tasks); this.emit('changed', this.snapshot());
    }
  }

  async pause(id) { this.controllers.get(id)?.abort(); }
  async resume(id) { return this.start(id); }
}

module.exports = { localDay, expandPathTemplate, selectFiles, copyFileResumable, CopyManager };
