const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { formatDay, isWithin, walkMedia, createVirtualLibrary, cleanupVirtualLibrary, summarize } = require('../electron/core.cjs');

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
