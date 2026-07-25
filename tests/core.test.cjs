const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { formatDay, isWithin, walkMedia, listDirectory, createVirtualLibrary, cleanupVirtualLibrary, summarize } = require('../electron/core.cjs');
const { expandPathTemplate, selectFiles, copyFileResumable, CopyManager } = require('../electron/copy-engine.cjs');

test('formatDay uses local calendar date', () => {
  assert.match(formatDay(new Date(2026, 6, 25, 12)), /^2026-07-25$/);
});

test('isWithin blocks sibling path traversal', () => {
  const root = path.join(os.tmpdir(), 'card');
  assert.equal(isWithin(root, path.join(root, 'DCIM', 'clip.mov')), true);
  assert.equal(isWithin(root, path.join(os.tmpdir(), 'card-copy', 'clip.mov')), false);
});

test('scan, summarize and filter a virtual library', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'material-gater-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source');
  const output = path.join(temp, 'output');
  await fs.mkdir(path.join(source, 'DCIM'), { recursive: true });
  await fs.writeFile(path.join(source, 'DCIM', 'A001.MOV'), Buffer.alloc(1024));
  await fs.writeFile(path.join(source, 'DCIM', 'A002.mp4'), Buffer.alloc(2048));
  await fs.writeFile(path.join(source, 'notes.txt'), 'ignore me');

  const files = await walkMedia(source);
  assert.equal(files.length, 2);
  assert.deepEqual(files.map((file) => file.extension).sort(), ['.mov', '.mp4']);
  assert.equal(summarize(files).size, 3072);

  const result = await createVirtualLibrary(files, { destination: output, extensions: ['.mov'] });
  assert.equal(result.total, 1);
  assert.equal(result.linked, 1);
  assert.equal(result.failures.length, 0);
  const manifest = JSON.parse(await fs.readFile(path.join(output, '.material-gater.json'), 'utf8'));
  assert.equal(manifest.linked, 1);
  assert.equal(manifest.targets.length, 1);
  const cleanup = await cleanupVirtualLibrary(output);
  assert.equal(cleanup.removed, 1);
  assert.equal(cleanup.kept, false);
});

test('cleanup refuses directories without a Material Gater manifest', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'material-gater-safe-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.writeFile(path.join(temp, 'user-file.mov'), 'keep');
  const result = await cleanupVirtualLibrary(temp, 'unknown');
  assert.equal(result.removed, 0);
  assert.equal(result.kept, true);
  assert.equal(await fs.readFile(path.join(temp, 'user-file.mov'), 'utf8'), 'keep');
});

test('cleanup preserves a user file that replaced a managed link', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'material-gater-replaced-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source');
  const output = path.join(temp, 'output');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'clip.mov'), 'source');
  const files = await walkMedia(source);
  const result = await createVirtualLibrary(files, { id: 'safe-map', destination: output });
  const target = path.join(output, result.targets[0].path);
  await fs.rm(target);
  await fs.writeFile(target, 'user replacement');

  const cleanup = await cleanupVirtualLibrary(output, 'safe-map');
  assert.equal(cleanup.removed, 0);
  assert.equal(cleanup.kept, true);
  assert.equal(await fs.readFile(target, 'utf8'), 'user replacement');
});

test('raw directory listing includes folders and non-media files', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'material-gater-browser-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.mkdir(path.join(temp, 'DCIM'));
  await fs.writeFile(path.join(temp, 'notes.txt'), 'notes');
  const entries = await listDirectory(temp);
  assert.deepEqual(entries.map((entry) => [entry.name, entry.directory]), [['DCIM', true], ['notes.txt', false]]);
});

test('copy templates, filters and resumable local writes', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'material-gater-copy-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'clip.mov');
  const destination = path.join(temp, 'vault', 'clip.mov');
  const content = Buffer.alloc(2 * 1024 * 1024, 7);
  await fs.writeFile(source, content);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(`${destination}.material-gater.part`, content.subarray(0, 512 * 1024));
  let transferred = 0;
  await copyFileResumable(source, destination, (bytes) => { transferred += bytes; });
  assert.equal((await fs.stat(destination)).size, content.length);
  assert.equal(transferred, content.length - 512 * 1024);
  const file = { id: '1', extension: '.mov', capturedAt: '2026-07-26T08:09:10.000Z' };
  const otherFile = { id: '2', extension: '.mov', capturedAt: '2026-07-26T08:09:11.000Z' };
  assert.match(expandPathTemplate('%day/%note("悟3")/%time', file), /^2026-07-26[/\\]悟3[/\\]/);
  assert.equal(selectFiles([file], { extensions: ['.mov'], startDate: '2026-07-26', endDate: '2026-07-26' }).length, 1);
  assert.deepEqual(selectFiles([file, otherFile], { fileIds: ['1'] }).map((item) => item.id), ['1']);
});

test('copy manager completes and persists a background task', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'material-gater-task-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source', 'clip.mov');
  const repository = { id: 'repo', type: 'local', root: path.join(temp, 'vault') };
  await fs.mkdir(path.dirname(source)); await fs.writeFile(source, Buffer.alloc(512 * 1024, 3));
  let persisted = 0;
  const manager = new CopyManager({ tasks: [], resolveRepository: () => repository, persist: async () => { persisted += 1; } });
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('copy task timeout')), 3000);
    manager.on('changed', (tasks) => { if (tasks[0]?.status === 'completed') { clearTimeout(timer); resolve(tasks[0]); } });
  });
  await manager.create({ name: 'test', repositoryId: 'repo', sourceUuid: 'source', selection: { fileIds: ['file'] }, pathTemplate: '%day/%note', note: 'unit', mode: 'flat' }, [{ id: 'file', name: 'clip.mov', path: source, relativePath: 'clip.mov', extension: '.mov', size: 512 * 1024, capturedAt: '2026-07-26T08:00:00.000Z' }]);
  const task = await completed;
  assert.equal(task.status, 'completed'); assert.ok(persisted >= 2);
  assert.equal((await fs.stat(path.join(repository.root, '2026-07-26', 'unit', 'clip.mov'))).size, 512 * 1024);
});
