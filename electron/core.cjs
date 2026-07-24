const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const MEDIA_EXTENSIONS = new Set([
  '.mov', '.mp4', '.mxf', '.avi', '.mkv', '.m4v', '.r3d', '.braw', '.ari',
  '.wav', '.mp3', '.aac', '.flac', '.jpg', '.jpeg', '.png', '.tif', '.tiff',
  '.cr2', '.cr3', '.nef', '.arw', '.dng'
]);

function formatDay(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function walkMedia(root, onProgress = () => {}) {
  const rootPath = path.resolve(root);
  const files = [];
  const pending = [rootPath];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '$RECYCLE.BIN' || entry.name === 'System Volume Information') continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        try {
          const stat = await fsp.stat(absolute);
          files.push({
            id: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`,
            name: entry.name,
            path: absolute,
            relativePath: path.relative(rootPath, absolute),
            extension: path.extname(entry.name).toLowerCase(),
            size: stat.size,
            capturedAt: stat.birthtimeMs > 0 ? stat.birthtime.toISOString() : stat.mtime.toISOString(),
            modifiedAt: stat.mtime.toISOString(),
            source: rootPath
          });
          visited += 1;
          if (visited % 100 === 0) onProgress(visited);
        } catch { /* The card may have been removed during scanning. */ }
      }
    }
  }
  return files;
}

async function listDrives(platform = process.platform) {
  if (platform === 'darwin') {
    const volumeRoot = '/Volumes';
    const names = await fsp.readdir(volumeRoot).catch(() => []);
    const results = [];
    for (const name of names) {
      const mount = path.join(volumeRoot, name);
      try {
        const stat = await fsp.stat(mount);
        if (!stat.isDirectory() || name === 'Macintosh HD') continue;
        results.push({ id: mount, name, path: mount, kind: /sd|card|untitled/i.test(name) ? 'SD' : '外置磁盘' });
      } catch { /* disappeared */ }
    }
    return results;
  }
  if (platform === 'win32') {
    const script = "Get-CimInstance Win32_LogicalDisk | Where-Object {$_.DriveType -in 2,3} | Select-Object DeviceID,VolumeName,DriveType,Size,FreeSpace | ConvertTo-Json -Compress";
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
      const parsed = JSON.parse(stdout.trim() || '[]');
      return (Array.isArray(parsed) ? parsed : [parsed]).map((disk) => ({
        id: disk.DeviceID,
        name: disk.VolumeName || disk.DeviceID,
        path: `${disk.DeviceID}\\`,
        kind: disk.DriveType === 2 ? '可移动磁盘' : '本地磁盘',
        size: disk.Size || 0,
        free: disk.FreeSpace || 0
      }));
    } catch { return []; }
  }
  return [];
}

async function linkFile(source, target) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.symlink(source, target, process.platform === 'win32' ? 'file' : undefined);
    return 'symlink';
  } catch (symlinkError) {
    try {
      await fsp.link(source, target);
      return 'hardlink';
    } catch {
      throw new Error(`无法创建链接：${symlinkError.message}`);
    }
  }
}

async function createVirtualLibrary(files, options) {
  const destination = path.resolve(options.destination);
  const selectedExts = new Set((options.extensions || []).map((item) => item.toLowerCase()));
  const start = options.startDate ? new Date(`${options.startDate}T00:00:00`) : null;
  const end = options.endDate ? new Date(`${options.endDate}T23:59:59.999`) : null;
  if (!destination || destination === path.parse(destination).root) throw new Error('请选择安全的目标目录');

  const selected = files.filter((file) => {
    const date = new Date(file.capturedAt);
    return (!selectedExts.size || selectedExts.has(file.extension)) && (!start || date >= start) && (!end || date <= end);
  });
  let linked = 0;
  const failures = [];
  for (const file of selected) {
    if (!isWithin(file.source, file.path)) continue;
    const day = formatDay(file.capturedAt);
    const safeRelative = file.relativePath.split(path.sep).map((part) => part.replace(/[<>:"|?*]/g, '_')).join(path.sep);
    const target = path.join(destination, day, safeRelative);
    try {
      await fsp.rm(target, { force: true });
      await linkFile(file.path, target);
      linked += 1;
    } catch (error) { failures.push({ file: file.path, error: error.message }); }
  }
  const manifest = { createdAt: new Date().toISOString(), filters: options, total: selected.length, linked, failures };
  await fsp.mkdir(destination, { recursive: true });
  await fsp.writeFile(path.join(destination, '.material-gater.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

function summarize(files) {
  const byDay = {};
  const byType = {};
  for (const file of files) {
    const day = formatDay(file.capturedAt);
    byDay[day] ||= { count: 0, size: 0 };
    byDay[day].count += 1;
    byDay[day].size += file.size;
    byType[file.extension] ||= { count: 0, size: 0 };
    byType[file.extension].count += 1;
    byType[file.extension].size += file.size;
  }
  return { count: files.length, size: files.reduce((sum, file) => sum + file.size, 0), byDay, byType };
}

module.exports = { MEDIA_EXTENSIONS, formatDay, isWithin, walkMedia, listDrives, createVirtualLibrary, summarize };
