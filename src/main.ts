import '@fontsource-variable/noto-sans-sc';
import './style.css';
import type { AppState, Drive, MappingInput, MappingProfile, MediaFile } from './types';

const root = document.querySelector<HTMLDivElement>('#app')!;
let state: AppState;
let drives: Drive[] = [];
let selectedSource = '';
let selectedMappingId = '';
let editorBuffer: MappingInput | null = null;
let activeView: 'mappings' | 'media' | 'activity' | 'source' = 'mappings';
let mediaMode: 'list' | 'tree' = 'list';
let busyAction = '';
let mappingSearch = '';
let fileSearch = '';
let filterExtension = '';
let filterStart = '';
let filterEnd = '';
let toastTimer = 0;

const commonExtensions = ['.mov', '.mp4', '.mxf', '.r3d', '.braw', '.wav', '.jpg'];
const chartColors = ['#4d8df7', '#7c5ce5', '#2fb59a', '#ef9a3c', '#e85f74', '#66a94f', '#47a8c9', '#9c6c4b'];
const icon = (name: 'folder' | 'drive' | 'map' | 'media' | 'chart' | 'plus' | 'play' | 'search' | 'list' | 'tree') => ({
  folder: '<path d="M3 7h7l2 2h9v10H3V7Z"/>',
  drive: '<path d="M5 4h14v16H5V4Zm3 11h8M9 8h6m2 9h.01"/>',
  map: '<path d="m4 6 5-2 6 2 5-2v14l-5 2-6-2-5 2V6Zm5-2v14m6-12v14"/>',
  media: '<path d="M4 5h16v14H4V5Zm4 0v14m8-14v14M4 9h4m8 0h4M4 15h4m8 0h4"/>',
  chart: '<path d="M5 19V9m7 10V5m7 14v-7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="m9 6 9 6-9 6V6Z"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  tree: '<path d="M6 4v16m0-12h5m-5 8h5m0-11v6h7m-7 2v6h7"/>'
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

function localDay(value: string): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function showToast(message: string, type: 'success' | 'error' = 'success') {
  let toast = document.querySelector<HTMLDivElement>('.toast');
  if (!toast) { toast = document.createElement('div'); toast.className = 'toast'; document.body.appendChild(toast); }
  toast.textContent = message; toast.dataset.type = type; toast.classList.add('visible');
  window.clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toast?.classList.remove('visible'), 3200);
}

function blankMapping(): MappingInput {
  return { name: `映射 ${state.catalog.mappings.length + 1}`, destination: '', extensions: [...commonExtensions], startDate: '', endDate: '' };
}

function currentMapping(): MappingInput | null {
  return editorBuffer || state.catalog.mappings.find((item) => item.id === selectedMappingId) || null;
}

function filteredFiles(): MediaFile[] {
  const query = fileSearch.trim().toLowerCase();
  const start = filterStart ? new Date(`${filterStart}T00:00:00`) : null;
  const end = filterEnd ? new Date(`${filterEnd}T23:59:59.999`) : null;
  return state.catalog.files.filter((file) => {
    const date = new Date(file.capturedAt);
    return (activeView !== 'source' || file.source === selectedSource)
      && (!filterExtension || file.extension === filterExtension)
      && (!start || date >= start) && (!end || date <= end)
      && (!query || `${file.name} ${file.relativePath}`.toLowerCase().includes(query));
  }).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

function sourceRows(): string {
  const rows = drives.map((drive) => `
    <button class="source-row ${activeView === 'source' && selectedSource === drive.path ? 'selected' : ''}" data-source="${escapeHtml(drive.path)}">
      ${svg('drive')}<span><strong>${escapeHtml(drive.name)}</strong><small>${escapeHtml(drive.kind)}</small></span><i></i>
    </button>`).join('');
  return rows || '<div class="pane-empty">未检测到外置磁盘</div>';
}

function mappingRows(): string {
  const mappings = state.catalog.mappings.filter((item) => `${item.name} ${item.destination}`.toLowerCase().includes(mappingSearch.toLowerCase()));
  if (!mappings.length) return `<div class="list-empty">${mappingSearch ? '没有匹配的映射' : '还没有映射<br><small>点击“新建映射”开始</small>'}</div>`;
  return mappings.map((mapping) => {
    const status = mapping.lastRun ? `${mapping.lastRun.linked}/${mapping.lastRun.total} 项` : '待运行';
    return `<button class="mapping-row ${mapping.id === selectedMappingId && !editorBuffer ? 'selected' : ''}" data-mapping="${mapping.id}">
      <span class="mapping-symbol">${svg('map')}</span><span class="mapping-main"><strong>${escapeHtml(mapping.name)}</strong><small>${escapeHtml(mapping.destination)}</small></span>
      <span class="mapping-status"><strong>${status}</strong><small>${formatDate(mapping.lastRun?.at)}</small></span><span class="chevron">›</span>
    </button>`;
  }).join('');
}

function fileRow(file: MediaFile, compact = false): string {
  return `<div class="media-row ${compact ? 'compact' : ''}"><span class="extension">${file.extension.slice(1).toUpperCase()}</span><span><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.relativePath)}</small></span><span>${new Date(file.capturedAt).toLocaleDateString('zh-CN')}</span><b>${formatBytes(file.size)}</b></div>`;
}

type TreeNode = { directories: Map<string, TreeNode>; files: MediaFile[] };
function buildTree(files: MediaFile[]): TreeNode {
  const rootNode: TreeNode = { directories: new Map(), files: [] };
  for (const file of files) {
    const parts = file.relativePath.split(/[\\/]/); parts.pop();
    let node = rootNode;
    for (const part of parts) {
      if (!node.directories.has(part)) node.directories.set(part, { directories: new Map(), files: [] });
      node = node.directories.get(part)!;
    }
    node.files.push(file);
  }
  return rootNode;
}

function treeCount(node: TreeNode): number {
  return node.files.length + [...node.directories.values()].reduce((sum, child) => sum + treeCount(child), 0);
}

function renderTree(node: TreeNode, depth = 0): string {
  const directories = [...node.directories.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN')).map(([name, child]) => `
    <details class="tree-directory" ${depth < 1 ? 'open' : ''}><summary style="--depth:${depth}">${svg('folder')}<strong>${escapeHtml(name)}</strong><span>${treeCount(child)}</span></summary>
      ${renderTree(child, depth + 1)}
    </details>`).join('');
  const files = node.files.map((file) => `<div class="tree-file" style="--depth:${depth}">${fileRow(file, true)}</div>`).join('');
  return directories + files;
}

function mediaExplorer(): string {
  const files = filteredFiles();
  if (!files.length) return '<div class="list-empty">没有符合条件的素材<br><small>可以调整过滤器或重新扫描素材源</small></div>';
  if (mediaMode === 'tree') return `<div class="tree-view">${renderTree(buildTree(files))}</div>`;
  return `<div class="table-head"><span>文件</span><span>日期</span><span>大小</span></div><div class="content-list">${files.slice(0, 1000).map((file) => fileRow(file)).join('')}</div>`;
}

function summarizeFiles(files: MediaFile[]) {
  const byDay: Record<string, { count: number; size: number }> = {};
  const byType: Record<string, { count: number; size: number }> = {};
  let size = 0;
  for (const file of files) {
    const day = localDay(file.capturedAt); size += file.size;
    byDay[day] ||= { count: 0, size: 0 }; byDay[day].count += 1; byDay[day].size += file.size;
    byType[file.extension] ||= { count: 0, size: 0 }; byType[file.extension].count += 1; byType[file.extension].size += file.size;
  }
  return { count: files.length, size, byDay, byType };
}

function statisticsDashboard(): string {
  const files = filteredFiles();
  const stats = summarizeFiles(files);
  const days = Object.entries(stats.byDay).sort(([a], [b]) => a.localeCompare(b)).slice(-14);
  const maxDaySize = Math.max(1, ...days.map(([, item]) => item.size));
  const types = Object.entries(stats.byType).sort(([, a], [, b]) => b.size - a.size);
  let cursor = 0;
  const stops = types.map(([, item], index) => { const start = cursor; cursor += stats.size ? item.size / stats.size * 100 : 0; return `${chartColors[index % chartColors.length]} ${start}% ${cursor}%`; }).join(', ');
  return `<div class="stats-dashboard">
    <section class="stat-cards"><article><span>筛选后素材</span><strong>${stats.count.toLocaleString()}</strong><small>个文件</small></article><article><span>总容量</span><strong>${formatBytes(stats.size)}</strong></article><article><span>拍摄日期</span><strong>${Object.keys(stats.byDay).length}</strong><small>天</small></article><article><span>文件类型</span><strong>${Object.keys(stats.byType).length}</strong><small>种</small></article></section>
    <section class="charts-grid">
      <article class="chart-card"><div class="chart-title"><div><h2>每日拍摄容量</h2><span>最近 ${days.length} 个拍摄日</span></div></div>
        ${days.length ? `<div class="bar-chart">${days.map(([day, item]) => `<div class="bar-column" title="${day} · ${formatBytes(item.size)}"><b>${formatBytes(item.size)}</b><div><span style="height:${Math.max(4, item.size / maxDaySize * 100)}%"></span></div><small>${day.slice(5)}</small></div>`).join('')}</div>` : '<div class="chart-empty">暂无数据</div>'}
      </article>
      <article class="chart-card"><div class="chart-title"><div><h2>文件类型占比</h2><span>按容量统计</span></div></div>
        ${types.length ? `<div class="pie-layout"><div class="pie" style="background:conic-gradient(${stops})"><span><strong>${types.length}</strong><small>种类型</small></span></div><div class="legend">${types.slice(0, 8).map(([ext, item], index) => `<div><i style="background:${chartColors[index % chartColors.length]}"></i><strong>${ext.slice(1).toUpperCase()}</strong><span>${(item.size / stats.size * 100).toFixed(1)}%</span><small>${formatBytes(item.size)}</small></div>`).join('')}</div></div>` : '<div class="chart-empty">暂无数据</div>'}
      </article>
    </section>
    <section class="stats-table"><div class="section-title"><h2>日期明细</h2></div><div class="table-head activity"><span>拍摄日期</span><span>数量</span><span>容量</span></div>${Object.entries(stats.byDay).sort(([a], [b]) => b.localeCompare(a)).map(([day, item]) => `<div class="activity-row"><span>${day}</span><strong>${item.count} 个文件</strong><b>${formatBytes(item.size)}</b></div>`).join('')}</section>
  </div>`;
}

function editor(): string {
  const mapping = currentMapping();
  if (!mapping) return `<section class="detail-placeholder">${svg('map')}<h2>选择一个映射</h2><p>在中间列表选择映射，或创建一个新的素材映射。</p><button class="button primary" id="empty-new">${svg('plus')}新建映射</button></section>`;
  const saved = mapping.id ? state.catalog.mappings.find((item) => item.id === mapping.id) : null;
  const available = [...new Set([...commonExtensions, ...Object.keys(state.stats.byType), ...mapping.extensions])].sort();
  return `<section class="editor"><div class="editor-title"><div><span>${mapping.id ? '映射详情' : '新建映射'}</span><h2>${escapeHtml(mapping.name || '未命名映射')}</h2></div>${saved ? '<button class="icon-button danger" id="delete-mapping" title="删除映射">×</button>' : ''}</div>
    ${saved?.lastRun ? `<div class="run-summary"><span class="status-dot ${saved.lastRun.failed ? 'warning' : ''}"></span><div><strong>上次运行 ${formatDate(saved.lastRun.at)}</strong><small>${saved.lastRun.linked} 个链接成功${saved.lastRun.failed ? `，${saved.lastRun.failed} 个失败` : ''}</small></div></div>` : ''}
    <label class="field"><span>名称</span><input id="mapping-name" value="${escapeHtml(mapping.name)}" placeholder="例如：今日 MOV 素材"></label>
    <label class="field"><span>输出目录</span><div class="path-input"><input id="mapping-destination" readonly value="${escapeHtml(mapping.destination)}" placeholder="选择剪辑软件读取的目录"><button id="pick-destination">选择…</button></div></label>
    <div class="field"><span>文件类型</span><div class="extensions">${available.map((ext) => `<label><input type="checkbox" value="${ext}" ${mapping.extensions.includes(ext) ? 'checked' : ''}><span>${ext.slice(1).toUpperCase()}</span></label>`).join('')}</div></div>
    <div class="date-grid"><label class="field"><span>开始日期</span><input id="mapping-start" type="date" value="${mapping.startDate}"></label><label class="field"><span>结束日期</span><input id="mapping-end" type="date" value="${mapping.endDate}"></label></div>
    <p class="note">留空日期表示全部素材。源文件不会被复制或修改。</p><div class="editor-actions"><button class="button" id="save-mapping" ${busyAction ? 'disabled' : ''}>${busyAction === 'save' ? '保存中…' : '保存'}</button><button class="button primary" id="run-mapping" ${!state.stats.count || busyAction ? 'disabled' : ''}>${svg('play')}${busyAction === 'run' ? '运行中…' : '保存并运行'}</button></div></section>`;
}

function filterControls(): string {
  const extensions = [...new Set(state.catalog.files.map((file) => file.extension))].sort();
  const search = activeView !== 'activity' ? `<label class="search">${svg('search')}<input id="file-search" value="${escapeHtml(fileSearch)}" placeholder="搜索文件"></label>` : '';
  const modes = activeView !== 'activity' ? `<div class="view-switch"><button data-mode="list" class="${mediaMode === 'list' ? 'active' : ''}" title="列表">${svg('list')}</button><button data-mode="tree" class="${mediaMode === 'tree' ? 'active' : ''}" title="树形列表">${svg('tree')}</button></div>` : '';
  return `${search}<select id="filter-extension"><option value="">全部类型</option>${extensions.map((ext) => `<option value="${ext}" ${filterExtension === ext ? 'selected' : ''}>${ext.slice(1).toUpperCase()}</option>`).join('')}</select><label class="date-filter">从 <input id="filter-start" type="date" value="${filterStart}"></label><label class="date-filter">至 <input id="filter-end" type="date" value="${filterEnd}"></label>${(fileSearch || filterExtension || filterStart || filterEnd) ? '<button class="clear-filter" id="clear-filter">清除</button>' : ''}${modes}`;
}

function centerContent(): string {
  if (activeView === 'media' || activeView === 'source') return mediaExplorer();
  if (activeView === 'activity') return statisticsDashboard();
  return `<div class="mapping-list">${mappingRows()}</div>`;
}

function viewTitle(): { title: string; subtitle: string } {
  if (activeView === 'mappings') return { title: '映射', subtitle: `${state.catalog.mappings.length} 个配置` };
  if (activeView === 'activity') { const stats = summarizeFiles(filteredFiles()); return { title: '统计', subtitle: `${stats.count} 个文件 · ${formatBytes(stats.size)}` }; }
  const files = filteredFiles();
  if (activeView === 'source') { const drive = drives.find((item) => item.path === selectedSource); return { title: drive?.name || '素材源预览', subtitle: `${files.length} 个文件 · ${formatBytes(files.reduce((sum, file) => sum + file.size, 0))}` }; }
  return { title: '素材', subtitle: `${files.length} 个文件 · ${formatBytes(files.reduce((sum, file) => sum + file.size, 0))}` };
}

function render() {
  const heading = viewTitle();
  root.innerHTML = `<div class="app-shell"><aside class="sidebar"><div class="brand"><span>MG</span><strong>Material Gater</strong></div><nav>
      <button class="${activeView === 'mappings' ? 'active' : ''}" data-view="mappings">${svg('map')}映射<span>${state.catalog.mappings.length}</span></button>
      <button class="${activeView === 'media' ? 'active' : ''}" data-view="media">${svg('media')}素材<span>${state.stats.count}</span></button>
      <button class="${activeView === 'activity' ? 'active' : ''}" data-view="activity">${svg('chart')}统计</button></nav>
      <div class="sidebar-heading"><span>素材源</span><button id="choose-source" title="选择目录">${svg('plus')}</button></div><div class="source-list">${sourceRows()}</div>
      ${selectedSource ? `<div class="scan-box"><span title="${escapeHtml(selectedSource)}">${escapeHtml(selectedSource)}</span><button id="scan-source" ${busyAction ? 'disabled' : ''}>${busyAction === 'scan' ? '扫描中…' : '重新扫描'}</button></div>` : ''}
      <button class="data-location" id="open-data">${svg('folder')}<span>本地数据库<small>${escapeHtml(state.dataDirectory)}</small></span></button></aside>
    <main class="workspace"><header class="toolbar"><div class="toolbar-heading"><h1>${escapeHtml(heading.title)}</h1><span>${heading.subtitle}</span></div><div class="toolbar-actions">${activeView === 'mappings' ? `<label class="search">${svg('search')}<input id="mapping-search" value="${escapeHtml(mappingSearch)}" placeholder="搜索映射"></label><button class="button primary" id="new-mapping">${svg('plus')}新建映射</button>` : filterControls()}</div></header>
      <div class="work-area ${activeView !== 'mappings' ? 'single' : ''}"><section class="list-pane">${centerContent()}</section>${activeView === 'mappings' ? `<aside class="detail-pane">${editor()}</aside>` : ''}</div></main></div>`;
  bindEvents();
}

function readEditor(): MappingInput {
  const current = currentMapping();
  return { id: current?.id, name: document.querySelector<HTMLInputElement>('#mapping-name')?.value.trim() || '', destination: document.querySelector<HTMLInputElement>('#mapping-destination')?.value || '', extensions: [...document.querySelectorAll<HTMLInputElement>('.extensions input:checked')].map((input) => input.value), startDate: document.querySelector<HTMLInputElement>('#mapping-start')?.value || '', endDate: document.querySelector<HTMLInputElement>('#mapping-end')?.value || '' };
}

async function saveCurrent(): Promise<MappingProfile | null> {
  try { const response = await window.materialGater.saveMapping(readEditor()); state = response.state; selectedMappingId = response.mapping.id; editorBuffer = null; return response.mapping; }
  catch (error) { showToast(error instanceof Error ? error.message : '保存失败', 'error'); return null; }
}

function bindEvents() {
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => button.onclick = () => { activeView = button.dataset.view as typeof activeView; render(); });
  document.querySelectorAll<HTMLButtonElement>('[data-source]').forEach((button) => button.onclick = () => { selectedSource = button.dataset.source || ''; activeView = 'source'; render(); });
  document.querySelectorAll<HTMLButtonElement>('[data-mapping]').forEach((button) => button.onclick = () => { selectedMappingId = button.dataset.mapping || ''; editorBuffer = null; render(); });
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => button.onclick = () => { mediaMode = button.dataset.mode as typeof mediaMode; render(); });
  const createNew = () => { activeView = 'mappings'; selectedMappingId = ''; editorBuffer = blankMapping(); render(); };
  document.querySelector<HTMLButtonElement>('#new-mapping')?.addEventListener('click', createNew); document.querySelector<HTMLButtonElement>('#empty-new')?.addEventListener('click', createNew);
  document.querySelector<HTMLInputElement>('#mapping-search')?.addEventListener('input', (event) => { mappingSearch = (event.target as HTMLInputElement).value; const list = document.querySelector('.mapping-list'); if (list) list.innerHTML = mappingRows(); });
  document.querySelector<HTMLInputElement>('#file-search')?.addEventListener('change', (event) => { fileSearch = (event.target as HTMLInputElement).value; render(); });
  document.querySelector<HTMLSelectElement>('#filter-extension')?.addEventListener('change', (event) => { filterExtension = (event.target as HTMLSelectElement).value; render(); });
  document.querySelector<HTMLInputElement>('#filter-start')?.addEventListener('change', (event) => { filterStart = (event.target as HTMLInputElement).value; render(); });
  document.querySelector<HTMLInputElement>('#filter-end')?.addEventListener('change', (event) => { filterEnd = (event.target as HTMLInputElement).value; render(); });
  document.querySelector<HTMLButtonElement>('#clear-filter')?.addEventListener('click', () => { fileSearch = ''; filterExtension = ''; filterStart = ''; filterEnd = ''; render(); });
  document.querySelector<HTMLButtonElement>('#choose-source')!.onclick = async () => { const value = await window.materialGater.chooseDirectory('选择素材源目录'); if (value) { selectedSource = value; activeView = 'source'; render(); } };
  document.querySelector<HTMLButtonElement>('#scan-source')?.addEventListener('click', async () => { busyAction = 'scan'; render(); try { state = await window.materialGater.scan(selectedSource); showToast(`已索引 ${state.stats.count} 个素材`); } catch (error) { showToast(error instanceof Error ? error.message : '扫描失败', 'error'); } finally { busyAction = ''; render(); } });
  document.querySelector<HTMLButtonElement>('#pick-destination')?.addEventListener('click', async () => { editorBuffer = readEditor(); const value = await window.materialGater.chooseDirectory('选择映射输出目录'); if (value && editorBuffer) editorBuffer.destination = value; render(); });
  document.querySelector<HTMLButtonElement>('#save-mapping')?.addEventListener('click', async () => { busyAction = 'save'; editorBuffer = readEditor(); render(); const mapping = await saveCurrent(); busyAction = ''; render(); if (mapping) showToast('映射已保存'); });
  document.querySelector<HTMLButtonElement>('#run-mapping')?.addEventListener('click', async () => { busyAction = 'run'; editorBuffer = readEditor(); render(); const mapping = await saveCurrent(); if (mapping) { try { const response = await window.materialGater.runMapping(mapping.id); state = response.state; showToast(`已生成 ${response.result.linked}/${response.result.total} 个链接`, response.result.failures.length ? 'error' : 'success'); } catch (error) { showToast(error instanceof Error ? error.message : '运行失败', 'error'); } } busyAction = ''; render(); });
  document.querySelector<HTMLButtonElement>('#delete-mapping')?.addEventListener('click', async () => { if (!selectedMappingId || !confirm('删除此映射配置？已生成的素材链接不会被删除。')) return; state = await window.materialGater.deleteMapping(selectedMappingId); selectedMappingId = state.catalog.mappings[0]?.id || ''; editorBuffer = null; render(); showToast('映射配置已删除'); });
  document.querySelector<HTMLButtonElement>('#open-data')!.onclick = () => void window.materialGater.openPath(state.dataDirectory);
}

async function init() {
  [state, drives] = await Promise.all([window.materialGater.getState(), window.materialGater.getDrives()]); selectedSource = state.catalog.source || drives[0]?.path || ''; selectedMappingId = state.catalog.mappings[0]?.id || '';
  window.materialGater.onDrivesChanged((next) => { drives = next; if (!selectedSource && drives[0]) selectedSource = drives[0].path; render(); }); render();
}

init().catch((error) => { root.innerHTML = `<div class="fatal">启动失败：${escapeHtml(String(error))}</div>`; });
