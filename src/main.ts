import './style.css';
import type { AppState, Drive, MappingInput, MappingProfile, MediaFile } from './types';

const root = document.querySelector<HTMLDivElement>('#app')!;
let state: AppState;
let drives: Drive[] = [];
let selectedSource = '';
let selectedMappingId = '';
let editorBuffer: MappingInput | null = null;
let activeView: 'mappings' | 'media' | 'activity' = 'mappings';
let busyAction = '';
let searchText = '';
let toastTimer = 0;

const commonExtensions = ['.mov', '.mp4', '.mxf', '.r3d', '.braw', '.wav', '.jpg'];
const icon = (name: 'folder' | 'drive' | 'map' | 'media' | 'chart' | 'plus' | 'play' | 'more' | 'search') => ({
  folder: '<path d="M3 7h7l2 2h9v10H3V7Z"/>',
  drive: '<path d="M5 4h14v16H5V4Zm3 11h8M9 8h6m2 9h.01"/>',
  map: '<path d="m4 6 5-2 6 2 5-2v14l-5 2-6-2-5 2V6Zm5-2v14m6-12v14"/>',
  media: '<path d="M4 5h16v14H4V5Zm4 0v14m8-14v14M4 9h4m8 0h4M4 15h4m8 0h4"/>',
  chart: '<path d="M5 19V9m7 10V5m7 14v-7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="m9 6 9 6-9 6V6Z"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>'
})[name];
const svg = (name: Parameters<typeof icon>[0]) => `<svg viewBox="0 0 24 24">${icon(name)}</svg>`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!);
}

function formatBytes(value: number): string {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index > 2 ? 2 : 1)} ${units[index]}`;
}

function formatDate(value?: string | null): string {
  return value ? new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '从未运行';
}

function showToast(message: string, type: 'success' | 'error' = 'success') {
  let toast = document.querySelector<HTMLDivElement>('.toast');
  if (!toast) { toast = document.createElement('div'); toast.className = 'toast'; document.body.appendChild(toast); }
  toast.textContent = message;
  toast.dataset.type = type;
  toast.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast?.classList.remove('visible'), 3200);
}

function blankMapping(): MappingInput {
  return { name: `映射 ${state.catalog.mappings.length + 1}`, destination: '', extensions: [...commonExtensions], startDate: '', endDate: '' };
}

function currentMapping(): MappingInput | null {
  if (editorBuffer) return editorBuffer;
  return state.catalog.mappings.find((item) => item.id === selectedMappingId) || null;
}

function sourceRows(): string {
  const rows = drives.map((drive) => `
    <button class="source-row ${selectedSource === drive.path ? 'selected' : ''}" data-source="${escapeHtml(drive.path)}">
      ${svg('drive')}<span><strong>${escapeHtml(drive.name)}</strong><small>${escapeHtml(drive.kind)}</small></span><i></i>
    </button>`).join('');
  return rows || '<div class="pane-empty">未检测到外置磁盘</div>';
}

function mappingRows(): string {
  const mappings = state.catalog.mappings.filter((item) => `${item.name} ${item.destination}`.toLowerCase().includes(searchText.toLowerCase()));
  if (!mappings.length) return `<div class="list-empty">${searchText ? '没有匹配的映射' : '还没有映射<br><small>点击“新建映射”开始</small>'}</div>`;
  return mappings.map((mapping) => {
    const selected = mapping.id === selectedMappingId && !editorBuffer?.id;
    const status = mapping.lastRun ? `${mapping.lastRun.linked}/${mapping.lastRun.total} 项` : '待运行';
    return `<button class="mapping-row ${selected ? 'selected' : ''}" data-mapping="${mapping.id}">
      <span class="mapping-symbol">${svg('map')}</span>
      <span class="mapping-main"><strong>${escapeHtml(mapping.name)}</strong><small>${escapeHtml(mapping.destination)}</small></span>
      <span class="mapping-status"><strong>${status}</strong><small>${formatDate(mapping.lastRun?.at)}</small></span>
      <span class="chevron">›</span>
    </button>`;
  }).join('');
}

function mediaRows(): string {
  const files = [...state.catalog.files].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  if (!files.length) return '<div class="list-empty">素材索引为空<br><small>先在左侧选择并扫描素材源</small></div>';
  return files.slice(0, 300).map((file: MediaFile) => `<div class="media-row">
    <span class="extension">${file.extension.slice(1).toUpperCase()}</span><span><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.relativePath)}</small></span>
    <span>${new Date(file.capturedAt).toLocaleDateString('zh-CN')}</span><b>${formatBytes(file.size)}</b>
  </div>`).join('');
}

function activityRows(): string {
  const days = Object.entries(state.stats.byDay).sort(([a], [b]) => b.localeCompare(a));
  if (!days.length) return '<div class="list-empty">暂无拍摄统计</div>';
  return days.map(([day, item]) => `<div class="activity-row"><span>${day}</span><strong>${item.count} 个文件</strong><b>${formatBytes(item.size)}</b></div>`).join('');
}

function editor(): string {
  const mapping = currentMapping();
  if (!mapping) return `<section class="detail-placeholder">${svg('map')}<h2>选择一个映射</h2><p>在中间列表选择映射，或创建一个新的素材映射。</p><button class="button primary" id="empty-new">${svg('plus')}新建映射</button></section>`;
  const saved = mapping.id ? state.catalog.mappings.find((item) => item.id === mapping.id) : null;
  const available = [...new Set([...commonExtensions, ...Object.keys(state.stats.byType), ...mapping.extensions])].sort();
  return `<section class="editor">
    <div class="editor-title"><div><span>${mapping.id ? '映射详情' : '新建映射'}</span><h2>${escapeHtml(mapping.name || '未命名映射')}</h2></div>${saved ? `<button class="icon-button danger" id="delete-mapping" title="删除映射">×</button>` : ''}</div>
    ${saved?.lastRun ? `<div class="run-summary"><span class="status-dot ${saved.lastRun.failed ? 'warning' : ''}"></span><div><strong>上次运行 ${formatDate(saved.lastRun.at)}</strong><small>${saved.lastRun.linked} 个链接成功${saved.lastRun.failed ? `，${saved.lastRun.failed} 个失败` : ''}</small></div></div>` : ''}
    <label class="field"><span>名称</span><input id="mapping-name" value="${escapeHtml(mapping.name)}" placeholder="例如：今日 MOV 素材"></label>
    <label class="field"><span>输出目录</span><div class="path-input"><input id="mapping-destination" readonly value="${escapeHtml(mapping.destination)}" placeholder="选择剪辑软件读取的目录"><button id="pick-destination">选择…</button></div></label>
    <div class="field"><span>文件类型</span><div class="extensions">${available.map((ext) => `<label><input type="checkbox" value="${ext}" ${mapping.extensions.includes(ext) ? 'checked' : ''}><span>${ext.slice(1).toUpperCase()}</span></label>`).join('')}</div></div>
    <div class="date-grid"><label class="field"><span>开始日期</span><input id="mapping-start" type="date" value="${mapping.startDate}"></label><label class="field"><span>结束日期</span><input id="mapping-end" type="date" value="${mapping.endDate}"></label></div>
    <p class="note">留空日期表示全部素材。源文件不会被复制或修改。</p>
    <div class="editor-actions"><button class="button" id="save-mapping" ${busyAction ? 'disabled' : ''}>${busyAction === 'save' ? '保存中…' : '保存'}</button><button class="button primary" id="run-mapping" ${!state.stats.count || busyAction ? 'disabled' : ''}>${svg('play')}${busyAction === 'run' ? '运行中…' : '保存并运行'}</button></div>
  </section>`;
}

function centerContent(): string {
  if (activeView === 'media') return `<div class="table-head"><span>文件</span><span>日期</span><span>大小</span></div><div class="content-list">${mediaRows()}</div>`;
  if (activeView === 'activity') return `<div class="table-head activity"><span>拍摄日期</span><span>数量</span><span>容量</span></div><div class="content-list">${activityRows()}</div>`;
  return `<div class="mapping-list">${mappingRows()}</div>`;
}

function render() {
  const title = activeView === 'mappings' ? '映射' : activeView === 'media' ? '素材' : '拍摄统计';
  root.innerHTML = `<div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span>MG</span><strong>Material Gater</strong></div>
      <nav>
        <button class="${activeView === 'mappings' ? 'active' : ''}" data-view="mappings">${svg('map')}映射<span>${state.catalog.mappings.length}</span></button>
        <button class="${activeView === 'media' ? 'active' : ''}" data-view="media">${svg('media')}素材<span>${state.stats.count}</span></button>
        <button class="${activeView === 'activity' ? 'active' : ''}" data-view="activity">${svg('chart')}统计</button>
      </nav>
      <div class="sidebar-heading"><span>素材源</span><button id="choose-source" title="选择目录">${svg('plus')}</button></div>
      <div class="source-list">${sourceRows()}</div>
      ${selectedSource ? `<div class="scan-box"><span title="${escapeHtml(selectedSource)}">${escapeHtml(selectedSource)}</span><button id="scan-source" ${busyAction ? 'disabled' : ''}>${busyAction === 'scan' ? '扫描中…' : '扫描素材'}</button></div>` : ''}
      <button class="data-location" id="open-data">${svg('folder')}<span>本地数据库<small>${escapeHtml(state.dataDirectory)}</small></span></button>
    </aside>
    <main class="workspace">
      <header class="toolbar"><div><h1>${title}</h1><span>${activeView === 'mappings' ? `${state.catalog.mappings.length} 个配置` : activeView === 'media' ? `${state.stats.count} 个文件 · ${formatBytes(state.stats.size)}` : `${Object.keys(state.stats.byDay).length} 个拍摄日`}</span></div>
        <div class="toolbar-actions">${activeView === 'mappings' ? `<label class="search">${svg('search')}<input id="search" value="${escapeHtml(searchText)}" placeholder="搜索映射"></label><button class="button primary" id="new-mapping">${svg('plus')}新建映射</button>` : ''}</div>
      </header>
      <div class="work-area ${activeView !== 'mappings' ? 'single' : ''}"><section class="list-pane">${centerContent()}</section>${activeView === 'mappings' ? `<aside class="detail-pane">${editor()}</aside>` : ''}</div>
    </main>
  </div>`;
  bindEvents();
}

function readEditor(): MappingInput {
  const current = currentMapping();
  return {
    id: current?.id,
    name: document.querySelector<HTMLInputElement>('#mapping-name')?.value.trim() || '',
    destination: document.querySelector<HTMLInputElement>('#mapping-destination')?.value || '',
    extensions: [...document.querySelectorAll<HTMLInputElement>('.extensions input:checked')].map((input) => input.value),
    startDate: document.querySelector<HTMLInputElement>('#mapping-start')?.value || '',
    endDate: document.querySelector<HTMLInputElement>('#mapping-end')?.value || ''
  };
}

async function saveCurrent(): Promise<MappingProfile | null> {
  try {
    const response = await window.materialGater.saveMapping(readEditor());
    state = response.state;
    selectedMappingId = response.mapping.id;
    editorBuffer = null;
    return response.mapping;
  } catch (error) { showToast(error instanceof Error ? error.message : '保存失败', 'error'); return null; }
}

function bindEvents() {
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => button.onclick = () => { activeView = button.dataset.view as typeof activeView; render(); });
  document.querySelectorAll<HTMLButtonElement>('[data-source]').forEach((button) => button.onclick = () => { selectedSource = button.dataset.source || ''; render(); });
  document.querySelectorAll<HTMLButtonElement>('[data-mapping]').forEach((button) => button.onclick = () => { selectedMappingId = button.dataset.mapping || ''; editorBuffer = null; render(); });
  const createNew = () => { activeView = 'mappings'; selectedMappingId = ''; editorBuffer = blankMapping(); render(); };
  document.querySelector<HTMLButtonElement>('#new-mapping')?.addEventListener('click', createNew);
  document.querySelector<HTMLButtonElement>('#empty-new')?.addEventListener('click', createNew);
  document.querySelector<HTMLInputElement>('#search')?.addEventListener('input', (event) => { searchText = (event.target as HTMLInputElement).value; const list = document.querySelector('.mapping-list'); if (list) list.innerHTML = mappingRows(); bindMappingRows(); });
  document.querySelector<HTMLButtonElement>('#choose-source')!.onclick = async () => { const value = await window.materialGater.chooseDirectory('选择素材源目录'); if (value) { selectedSource = value; render(); } };
  document.querySelector<HTMLButtonElement>('#scan-source')?.addEventListener('click', async () => {
    busyAction = 'scan'; render();
    try { state = await window.materialGater.scan(selectedSource); showToast(`已索引 ${state.stats.count} 个素材`); }
    catch (error) { showToast(error instanceof Error ? error.message : '扫描失败', 'error'); }
    finally { busyAction = ''; render(); }
  });
  document.querySelector<HTMLButtonElement>('#pick-destination')?.addEventListener('click', async () => {
    editorBuffer = readEditor();
    const value = await window.materialGater.chooseDirectory('选择映射输出目录');
    if (value && editorBuffer) editorBuffer.destination = value;
    render();
  });
  document.querySelector<HTMLButtonElement>('#save-mapping')?.addEventListener('click', async () => {
    busyAction = 'save'; const values = readEditor(); editorBuffer = values; render();
    const mapping = await saveCurrent(); busyAction = ''; render(); if (mapping) showToast('映射已保存');
  });
  document.querySelector<HTMLButtonElement>('#run-mapping')?.addEventListener('click', async () => {
    busyAction = 'run'; editorBuffer = readEditor(); render();
    const mapping = await saveCurrent();
    if (mapping) {
      try { const response = await window.materialGater.runMapping(mapping.id); state = response.state; showToast(`已生成 ${response.result.linked}/${response.result.total} 个链接`, response.result.failures.length ? 'error' : 'success'); }
      catch (error) { showToast(error instanceof Error ? error.message : '运行失败', 'error'); }
    }
    busyAction = ''; render();
  });
  document.querySelector<HTMLButtonElement>('#delete-mapping')?.addEventListener('click', async () => {
    if (!selectedMappingId || !confirm('删除此映射配置？已生成的素材链接不会被删除。')) return;
    state = await window.materialGater.deleteMapping(selectedMappingId); selectedMappingId = state.catalog.mappings[0]?.id || ''; editorBuffer = null; render(); showToast('映射配置已删除');
  });
  document.querySelector<HTMLButtonElement>('#open-data')!.onclick = () => void window.materialGater.openPath(state.dataDirectory);
}

function bindMappingRows() {
  document.querySelectorAll<HTMLButtonElement>('[data-mapping]').forEach((button) => button.onclick = () => { selectedMappingId = button.dataset.mapping || ''; editorBuffer = null; render(); });
}

async function init() {
  [state, drives] = await Promise.all([window.materialGater.getState(), window.materialGater.getDrives()]);
  selectedSource = state.catalog.source || drives[0]?.path || '';
  selectedMappingId = state.catalog.mappings[0]?.id || '';
  window.materialGater.onDrivesChanged((next) => { drives = next; if (!selectedSource && drives[0]) selectedSource = drives[0].path; render(); });
  render();
}

init().catch((error) => { root.innerHTML = `<div class="fatal">启动失败：${escapeHtml(String(error))}</div>`; });
