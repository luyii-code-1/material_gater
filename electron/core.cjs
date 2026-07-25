const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { exec, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
let previousIoCounters = new Map();
let previousIoTime = Date.now();

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
        let device = ''; let uuid = '';
        try {
          const { stdout } = await execFileAsync('/usr/sbin/diskutil', ['info', mount]);
          device = stdout.match(/Part of Whole:\s+(disk\d+)/)?.[1] || stdout.match(/Device Identifier:\s+(disk\d+)/)?.[1] || '';
          uuid = stdout.match(/Volume UUID:\s+([A-Fa-f0-9-]+)/)?.[1]?.toUpperCase() || stdout.match(/Disk \/ Partition UUID:\s+([A-Fa-f0-9-]+)/)?.[1]?.toUpperCase() || '';
        } catch { /* volume may have disappeared */ }
        results.push({ id: uuid || mount, uuid: uuid || mount, name, path: mount, device, kind: /sd|card|untitled/i.test(name) ? 'SD' : '外置磁盘' });
      } catch { /* disappeared */ }
    }
    return results;
  }
  if (platform === 'win32') {
    const script = "Get-CimInstance Win32_LogicalDisk | Where-Object {$_.DriveType -in 2,3} | Select-Object DeviceID,VolumeName,VolumeSerialNumber,DriveType,Size,FreeSpace | ConvertTo-Json -Compress";
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
      const parsed = JSON.parse(stdout.trim() || '[]');
      return (Array.isArray(parsed) ? parsed : [parsed]).map((disk) => ({
        id: disk.VolumeSerialNumber ? `${disk.DeviceID}:${disk.VolumeSerialNumber}` : disk.DeviceID,
        uuid: disk.VolumeSerialNumber ? `${disk.DeviceID}:${disk.VolumeSerialNumber}` : disk.DeviceID,
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

async function listDirectory(root, relative = '') {
  const base = path.resolve(root);
  const directory = path.resolve(base, relative || '.');
  if (!isWithin(base, directory)) throw new Error('目录超出素材源范围');
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const rows = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'System Volume Information' || entry.name === '$RECYCLE.BIN') continue;
    const absolute = path.join(directory, entry.name);
    try {
      const stat = await fsp.stat(absolute);
      rows.push({
        name: entry.name, path: absolute, relativePath: path.relative(base, absolute),
        directory: entry.isDirectory(), extension: entry.isDirectory() ? '' : path.extname(entry.name).toLowerCase(),
        size: stat.size, modifiedAt: stat.mtime.toISOString()
      });
    } catch { /* item disappeared */ }
  }
  return rows.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'zh-CN'));
}

async function sampleDriveIo(drives, platform = process.platform) {
  if (!drives.length) return [];
  if (platform === 'darwin') {
    try {
      const command = `/usr/sbin/ioreg -r -c IOBlockStorageDriver -l | /usr/bin/grep -E '"Statistics"| "BSD Name"'`;
      const { stdout } = await execAsync(command, { maxBuffer: 2 * 1024 * 1024 });
      const counters = new Map();
      // IORegistry also prints nested APFS statistics. Only the driver-level
      // block contains the exact cumulative "Bytes (Read/Write)" counters.
      const pattern = /"Statistics" = (\{(?=[^\n]*"Bytes \(Read\)"=\d+)(?=[^\n]*"Bytes \(Write\)"=\d+)[^\n]+\})[\s\S]*?"BSD Name" = "(disk\d+)"/g;
      for (const match of stdout.matchAll(pattern)) {
        const read = Number(match[1].match(/"Bytes \(Read\)"=(\d+)/)?.[1] || 0);
        const write = Number(match[1].match(/"Bytes \(Write\)"=(\d+)/)?.[1] || 0);
        counters.set(match[2], { read, write });
      }
      const now = Date.now();
      const elapsed = Math.max(0.25, (now - previousIoTime) / 1000);
      const result = drives.map((drive) => {
        const current = counters.get(drive.device);
        const previous = previousIoCounters.get(drive.device);
        return { id: drive.id, readBps: current && previous ? Math.max(0, (current.read - previous.read) / elapsed) : 0, writeBps: current && previous ? Math.max(0, (current.write - previous.write) / elapsed) : 0 };
      });
      previousIoCounters = counters; previousIoTime = now;
      return result;
    } catch { return drives.map((drive) => ({ id: drive.id, readBps: 0, writeBps: 0 })); }
  }
  if (platform === 'win32') {
    const script = "Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk | Where-Object {$_.Name -ne '_Total'} | Select-Object Name,DiskReadBytesPersec,DiskWriteBytesPersec | ConvertTo-Json -Compress";
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
      const parsed = JSON.parse(stdout.trim() || '[]');
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return drives.map((drive) => {
        const row = rows.find((item) => item.Name === drive.id);
        return { id: drive.id, readBps: Number(row?.DiskReadBytesPersec || 0), writeBps: Number(row?.DiskWriteBytesPersec || 0) };
      });
    } catch { return drives.map((drive) => ({ id: drive.id, readBps: 0, writeBps: 0 })); }
  }
  return drives.map((drive) => ({ id: drive.id, readBps: 0, writeBps: 0 }));
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
  const targets = [];
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
      targets.push({ path: path.relative(destination, target), source: file.path });
    } catch (error) { failures.push({ file: file.path, error: error.message }); }
  }
  const manifest = { version: 3, mappingId: options.id || null, createdAt: new Date().toISOString(), filters: options, targets, total: selected.length, linked, failures };
  await fsp.mkdir(destination, { recursive: true });
  await fsp.writeFile(path.join(destination, '.material-gater.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function removeLegacyLinks(directory) {
  let removed = 0;
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const stat = await fsp.lstat(target).catch(() => null);
    if (!stat) continue;
    if (stat.isSymbolicLink()) { await fsp.rm(target, { force: true }); removed += 1; }
    else if (stat.isDirectory()) removed += await removeLegacyLinks(target);
  }
  return removed;
}

async function pruneEmptyDirectories(directory, includeRoot = true) {
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) if (entry.isDirectory()) await pruneEmptyDirectories(path.join(directory, entry.name), true);
  const remaining = await fsp.readdir(directory).catch(() => null);
  if (includeRoot && remaining?.length === 0) await fsp.rmdir(directory).catch(() => {});
}

async function cleanupVirtualLibrary(destination, mappingId) {
  const root = path.resolve(destination);
  if (root === path.parse(root).root) throw new Error('拒绝清理磁盘根目录');
  const manifestPath = path.join(root, '.material-gater.json');
  let manifest;
  try { manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')); }
  catch { return { removed: 0, kept: true, message: '输出目录没有 Material Gater 清单，未删除任何文件' }; }
  if (manifest.mappingId && mappingId && manifest.mappingId !== mappingId) throw new Error('输出目录属于另一个映射，已停止清理');
  let removed = 0;
  if (Array.isArray(manifest.targets)) {
    for (const entry of manifest.targets) {
      const relative = typeof entry === 'string' ? entry : entry?.path;
      if (!relative) continue;
      const target = path.resolve(root, relative);
      if (!isWithin(root, target) || target === root) continue;
      const targetStat = await fsp.lstat(target).catch(() => null);
      if (!targetStat) continue;
      let managed = typeof entry === 'string';
      if (!managed && entry.source) {
        if (targetStat.isSymbolicLink()) {
          const link = await fsp.readlink(target).catch(() => '');
          managed = path.resolve(path.dirname(target), link) === path.resolve(entry.source);
        } else {
          const sourceStat = await fsp.stat(entry.source).catch(() => null);
          managed = Boolean(sourceStat && targetStat.dev === sourceStat.dev && targetStat.ino === sourceStat.ino);
        }
      }
      if (managed) { await fsp.rm(target, { force: true }); removed += 1; }
    }
  } else {
    removed = await removeLegacyLinks(root);
  }
  await fsp.rm(manifestPath, { force: true });
  await pruneEmptyDirectories(root, true);
  const kept = Boolean(await fsp.stat(root).catch(() => null));
  return { removed, kept, message: kept ? `已删除 ${removed} 个受管链接；目录中其他文件已保留` : `已删除 ${removed} 个受管链接和空目录` };
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

module.exports = { MEDIA_EXTENSIONS, formatDay, isWithin, walkMedia, listDirectory, listDrives, sampleDriveIo, createVirtualLibrary, cleanupVirtualLibrary, summarize };
