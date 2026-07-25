const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const posix = path.posix;
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { Client: FtpClient } = require('basic-ftp');
const SftpClient = require('ssh2-sftp-client');
const SMB2 = require('@marsaud/smb2');
const { copyFileResumable } = require('./copy-engine.cjs');

function meter(onProgress) {
  return new Transform({ transform(chunk, _encoding, callback) { onProgress(chunk.length); callback(null, chunk); } });
}

function remotePath(repository, relative, suffix = '') {
  const configured = repository.remotePath || '/';
  const base = configured.startsWith('/') ? configured : `/${configured}`;
  return posix.join(base, ...relative.split(/[\\/]/), suffix).replace(/\/$/, '');
}

class LocalSession {
  constructor(repository) { this.repository = repository; }
  copy(source, relative, progress, signal) { return copyFileResumable(source, path.join(this.repository.root, relative), progress, signal); }
  async close() {}
}

class FtpSession {
  constructor(repository, password) { this.repository = repository; this.password = password; this.client = new FtpClient(30000); }
  async connect() { await this.client.access({ host: this.repository.address, port: this.repository.port || 21, user: this.repository.username || 'anonymous', password: this.password || 'guest', secure: false }); }
  async copy(source, relative, progress, signal) {
    if (signal?.aborted) throw new Error('任务已暂停');
    signal?.addEventListener('abort', () => this.client.close(), { once: true });
    const final = remotePath(this.repository, relative); const partial = `${final}.material-gater.part`;
    await this.client.ensureDir(posix.dirname(final));
    const sourceSize = (await fsp.stat(source)).size;
    let offset = await this.client.size(partial).catch(() => 0);
    if (offset > sourceSize) { await this.client.remove(partial).catch(() => {}); offset = 0; }
    let previous = 0;
    this.client.trackProgress((info) => { const delta = Math.max(0, info.bytesOverall - previous); previous = info.bytesOverall; if (delta) progress(delta, offset + info.bytesOverall, sourceSize); });
    if (offset) await this.client.appendFrom(source, partial, { localStart: offset }); else await this.client.uploadFrom(source, partial);
    this.client.trackProgress();
    await this.client.remove(final).catch(() => {}); await this.client.rename(partial, final);
    return { copied: sourceSize, skipped: false };
  }
  async close() { this.client.close(); }
}

class SftpSession {
  constructor(repository, password) { this.repository = repository; this.password = password; this.client = new SftpClient('Material Gater'); }
  async connect() { await this.client.connect({ host: this.repository.address, port: this.repository.port || 22, username: this.repository.username, password: this.password }); }
  async copy(source, relative, progress, signal) {
    if (signal?.aborted) throw new Error('任务已暂停');
    const final = remotePath(this.repository, relative); const partial = `${final}.material-gater.part`;
    await this.client.mkdir(posix.dirname(final), true);
    const sourceSize = (await fsp.stat(source)).size; const remote = await this.client.exists(partial); let offset = remote ? (await this.client.stat(partial)).size : 0;
    if (offset > sourceSize) { await this.client.delete(partial, true); offset = 0; }
    let copied = offset;
    const input = fs.createReadStream(source, { start: offset });
    const measured = input.pipe(meter((bytes) => { copied += bytes; progress(bytes, copied, sourceSize); if (signal?.aborted) input.destroy(new Error('任务已暂停')); }));
    if (offset) await this.client.append(measured, partial); else await this.client.put(measured, partial);
    if (await this.client.exists(final)) await this.client.delete(final, true); await this.client.rename(partial, final);
    return { copied: sourceSize, skipped: false };
  }
  async close() { await this.client.end().catch(() => {}); }
}

function callback(client, method, ...args) { return new Promise((resolve, reject) => client[method](...args, (error, value) => error ? reject(error) : resolve(value))); }
class SmbSession {
  constructor(repository, password) {
    this.repository = repository;
    this.client = new SMB2({ share: repository.address, domain: repository.domain || '', username: repository.username || '', password: password || '', autoCloseTimeout: 0 });
  }
  async connect() {}
  async ensureDirectory(directory) { let current = ''; for (const part of directory.split(/[\\/]/).filter(Boolean)) { current = current ? `${current}\\${part}` : part; await callback(this.client, 'mkdir', current).catch((error) => { if (!/exist/i.test(error.message)) throw error; }); } }
  async copy(source, relative, progress, signal) {
    if (signal?.aborted) throw new Error('任务已暂停');
    const final = path.win32.join(this.repository.remotePath || '', ...relative.split(/[\\/]/)); const partial = `${final}.material-gater.part`;
    await this.ensureDirectory(path.win32.dirname(final));
    const sourceSize = (await fsp.stat(source)).size; const remoteStat = await callback(this.client, 'stat', partial).catch(() => null); let offset = remoteStat?.size || 0;
    if (offset > sourceSize) { await callback(this.client, 'unlink', partial).catch(() => {}); offset = 0; }
    const read = fs.createReadStream(source, { start: offset }); let copied = offset;
    const measured = read.pipe(meter((bytes) => { copied += bytes; progress(bytes, copied, sourceSize); if (signal?.aborted) read.destroy(new Error('任务已暂停')); }));
    const write = await callback(this.client, 'createWriteStream', partial, { flags: offset ? 'r+' : 'w', start: offset });
    await pipeline(measured, write); await callback(this.client, 'unlink', final).catch(() => {}); await callback(this.client, 'rename', partial, final);
    return { copied: sourceSize, skipped: false };
  }
  async close() { this.client.disconnect(); }
}

async function createRepositorySession(repository, password) {
  const Session = repository.type === 'ftp' ? FtpSession : repository.type === 'sftp' ? SftpSession : repository.type === 'smb' && !repository.root ? SmbSession : LocalSession;
  const session = new Session(repository, password); await session.connect?.(); return session;
}

module.exports = { createRepositorySession, LocalSession, FtpSession, SftpSession, SmbSession };
