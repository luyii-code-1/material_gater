const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { formatDay, isWithin, walkMedia, createVirtualLibrary, summarize } = require('../electron/core.cjs');

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
});
