import './style.css';
import type { AppState, Drive, MediaFile } from './types';

const app = document.querySelector<HTMLDivElement>('#app')!;
let state: AppState;
let drives: Drive[] = [];
let selectedSource = '';
let selectedDestination = '';
let busy = false;
let toastTimer = 0;

const icons = {
  dashboard: '<svg viewBox="0 0 24 24"><path d="M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6v-9h-6v9Zm0-16v5h6V4h-6Z"/></svg>',
  drive: '<svg viewBox="0 0 24 24"><path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Zm3 9h10M8 8h8m1 9h.01"/></svg>',
  library: '<svg viewBox="0 0 24 24"><path d="m4 6 8-3 8 3v12l-8 3-8-3V6Zm8-3v18M4 6l8 3 8-3"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>',
};

function formatBytes(value: number): string {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** i).toFixed(i > 2 ? 2 : 1)} ${units[i]}`;
}

function dateText(value: string | null): string {
  return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '尚未扫描';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!);
}

function showToast(message: string, kind: 'success' | 'error' = 'success') {
  let toast = document.querySelector<HTMLDivElement>('.toast');
  if (!toast) { toast = document.createElement('div'); toast.className = 'toast'; document.body.appendChild(toast); }
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast?.classList.remove('show'), 3600);
}

function extensionPills(): string {
  const common = ['.mov', '.mp4', '.mxf', '.r3d', '.braw', '.wav', '.jpg'];
  const available = new Set([...common, ...Object.keys(state.stats.byType)]);
  return [...available].sort().map((ext) => `<label class="check-pill"><input type="checkbox" value="${ext}" checked><span>${ext.toUpperCase()}</span></label>`).join('');
}

function dayRows(): string {
  const entries = Object.entries(state.stats.byDay).sort(([a], [b]) => b.localeCompare(a));
  if (!entries.length) return '<div class="empty compact">扫描素材后，这里会显示每日拍摄量。</div>';
  const max = Math.max(...entries.map(([, value]) => value.size));
  return entries.slice(0, 8).map(([day, value]) => `
    <div class="day-row">
      <div><strong>${day}</strong><small>${value.count} 个素材</small></div>
      <div class="bar"><span style="width:${Math.max(3, value.size / max * 100)}%"></span></div>
      <b>${formatBytes(value.size)}</b>
    </div>`).join('');
}

function driveCards(): string {
  if (!drives.length) return '<div class="empty">尚未检测到外置素材盘<br><small>插入 SD 卡或 SSD 后会自动刷新，也可以手动选择目录。</small></div>';
  return drives.map((drive) => `
    <button class="drive-card ${selectedSource === drive.path ? 'selected' : ''}" data-drive="${escapeHtml(drive.path)}">
      <span class="drive-icon">${icons.drive}</span>
      <span><strong>${escapeHtml(drive.name)}</strong><small>${drive.kind} · ${escapeHtml(drive.path)}</small></span>
      <i></i>
    </button>`).join('');
}

function recentFiles(): string {
  const files = [...state.catalog.files].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)).slice(0, 8);
  if (!files.length) return '<div class="empty compact">素材索引为空。</div>';
  return files.map((file: MediaFile) => `<div class="file-row"><span class="file-ext">${file.extension.slice(1).toUpperCase()}</span><span><strong>${escapeHtml(file.name)}</strong><small>${new Date(file.capturedAt).toLocaleDateString('zh-CN')}</small></span><b>${formatBytes(file.size)}</b></div>`).join('');
}

function render() {
  app.innerHTML = `
    <aside>
      <div class="brand"><span>MG</span><div>Material Gater<small>素材门卫</small></div></div>
      <nav>
        <a href="#dashboard" class="active">${icons.dashboard}<span>概览</span></a>
        <a href="#sources">${icons.drive}<span>素材盘</span><em>${drives.length}</em></a>
        <a href="#library">${icons.library}<span>虚拟素材库</span></a>
      </nav>
      <div class="side-status"><span class="pulse"></span><div><strong>自动检测已开启</strong><small>每 4 秒检查新磁盘</small></div></div>
      <button class="data-path" id="open-data">本地索引<br><span>${escapeHtml(state.dataDirectory)}</span></button>
    </aside>
    <main>
      <header><div><p>工作台</p><h1>今天的素材，一目了然。</h1></div><div class="header-meta">上次扫描<br><strong>${dateText(state.catalog.lastScan)}</strong></div></header>
      <section class="metrics" id="dashboard">
        <article><span>已索引素材</span><strong>${state.stats.count.toLocaleString()}</strong><small>个文件</small></article>
        <article><span>素材总容量</span><strong>${formatBytes(state.stats.size).split(' ')[0]}</strong><small>${formatBytes(state.stats.size).split(' ')[1] || ''}</small></article>
        <article><span>拍摄日期</span><strong>${Object.keys(state.stats.byDay).length}</strong><small>天</small></article>
        <article class="accent"><span>已接入素材盘</span><strong>${drives.length}</strong><small>块</small></article>
      </section>
      <section class="grid">
        <article class="panel source-panel" id="sources">
          <div class="panel-title"><div><span class="eyebrow">01 / INGEST</span><h2>选择素材源</h2></div><button class="ghost" id="choose-source">${icons.folder} 选择目录</button></div>
          <div class="drive-list">${driveCards()}</div>
          <div class="selection"><span>当前来源</span><strong title="${escapeHtml(selectedSource)}">${selectedSource ? escapeHtml(selectedSource) : '请选择素材盘或目录'}</strong><button class="primary" id="scan" ${!selectedSource || busy ? 'disabled' : ''}>${busy ? '扫描中…' : '扫描并建立索引'}</button></div>
        </article>
        <article class="panel library-panel" id="library">
          <div class="panel-title"><div><span class="eyebrow">02 / GATE</span><h2>生成干净素材库</h2></div></div>
          <label class="field"><span>输出目录</span><div><input id="destination" readonly value="${escapeHtml(selectedDestination)}" placeholder="选择剪辑软件读取的目录"><button id="choose-destination">浏览</button></div></label>
          <div class="field"><span>保留类型</span><div class="pills">${extensionPills()}</div></div>
          <div class="date-fields"><label class="field"><span>开始日期</span><input id="start-date" type="date"></label><label class="field"><span>结束日期</span><input id="end-date" type="date"></label></div>
          <button class="primary wide" id="create-library" ${!selectedDestination || !state.stats.count || busy ? 'disabled' : ''}>创建映射素材库 <span>→</span></button>
          <p class="hint">不复制原片。优先创建符号链接，失败时尝试硬链接；按拍摄日期自动分组。</p>
        </article>
        <article class="panel stats-panel"><div class="panel-title"><div><span class="eyebrow">03 / DAILY VOLUME</span><h2>每日拍摄量</h2></div></div>${dayRows()}</article>
        <article class="panel files-panel"><div class="panel-title"><div><span class="eyebrow">RECENT MEDIA</span><h2>最近素材</h2></div><button class="text-button" id="clear">清空索引</button></div>${recentFiles()}</article>
      </section>
    </main>`;
  bindEvents();
}

function bindEvents() {
  document.querySelectorAll<HTMLButtonElement>('[data-drive]').forEach((button) => button.onclick = () => { selectedSource = button.dataset.drive || ''; render(); });
  document.querySelector<HTMLButtonElement>('#choose-source')!.onclick = async () => { const value = await window.materialGater.chooseDirectory('选择素材源目录'); if (value) { selectedSource = value; render(); } };
  document.querySelector<HTMLButtonElement>('#choose-destination')!.onclick = async () => { const value = await window.materialGater.chooseDirectory('选择虚拟素材库目录'); if (value) { selectedDestination = value; render(); } };
  document.querySelector<HTMLButtonElement>('#scan')!.onclick = async () => {
    busy = true; render();
    try { state = await window.materialGater.scan(selectedSource); showToast(`已索引 ${state.stats.count} 个素材`); }
    catch (error) { showToast(error instanceof Error ? error.message : '扫描失败', 'error'); }
    finally { busy = false; render(); }
  };
  document.querySelector<HTMLButtonElement>('#create-library')!.onclick = async () => {
    const extensions = [...document.querySelectorAll<HTMLInputElement>('.check-pill input:checked')].map((input) => input.value);
    const startDate = document.querySelector<HTMLInputElement>('#start-date')!.value;
    const endDate = document.querySelector<HTMLInputElement>('#end-date')!.value;
    busy = true; render();
    try {
      const result = await window.materialGater.createLibrary({ destination: selectedDestination, extensions, startDate, endDate });
      showToast(`已创建 ${result.linked}/${result.total} 个素材链接${result.failures.length ? `，${result.failures.length} 个失败` : ''}`, result.failures.length ? 'error' : 'success');
    } catch (error) { showToast(error instanceof Error ? error.message : '创建失败', 'error'); }
    finally { busy = false; render(); }
  };
  document.querySelector<HTMLButtonElement>('#clear')!.onclick = async () => { if (confirm('仅清空本地索引，不会删除任何素材。确定继续？')) { state = await window.materialGater.clearCatalog(); render(); showToast('索引已清空'); } };
  document.querySelector<HTMLButtonElement>('#open-data')!.onclick = () => void window.materialGater.openPath(state.dataDirectory);
}

async function init() {
  [state, drives] = await Promise.all([window.materialGater.getState(), window.materialGater.getDrives()]);
  selectedSource = state.catalog.source || drives[0]?.path || '';
  window.materialGater.onDrivesChanged((next) => { drives = next; if (!selectedSource && drives[0]) selectedSource = drives[0].path; render(); });
  render();
}

init().catch((error) => { app.innerHTML = `<div class="fatal">启动失败：${escapeHtml(String(error))}</div>`; });
