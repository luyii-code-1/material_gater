import '@fontsource-variable/noto-sans-sc';
import './tauri-bridge';
import './style.css';
import type { AppState, BackgroundTask, CopyPreset, DirectoryEntry, Drive, DriveHealth, MappingInput, MappingProfile, MediaFile, Repository, RepositoryType } from './types';

const root = document.querySelector<HTMLDivElement>('#app')!;
type View = 'mappings' | 'activity' | 'copy' | 'repositories' | 'settings' | 'source';
let state: AppState; let drives: Drive[] = []; let activeView: View = 'copy'; let selectedSourceUuid = ''; let selectedMappingId = '';
let editorBuffer: MappingInput | null = null; let deleteConfirmOpen = false; let busyAction = ''; let toastTimer = 0;
let filterExtension = ''; let filterStart = ''; let filterEnd = '';
let rawPath = ''; let rawEntries: DirectoryEntry[] = []; let rawBusy = false;
let selectedRepositoryId = ''; let repositoryDraft: Partial<Repository> | null = null;
let copySelected = new Set<string>(); let copySourceUuid = ''; let copyRepositoryId = ''; let copyCustomDestination = ''; let copyExtensions: string[] = []; let copyStart = ''; let copyEnd = ''; let copyNote = ''; let copyTemplate = ''; let copyMode: 'flat' | 'original' = 'flat';
let copyStep: 1 | 2 | 3 = 1; let copySection: 'create' | 'tasks' = 'create'; let copyDestinationMode: 'default' | 'custom' = 'default'; let activePresetId = ''; let copyPresetName = '';
let copySelectionMode: 'grouped' | 'directory' = 'grouped'; let copyCustomDirectory = ''; let copyPickerOpen = false; const collapsedCopyDays = new Set<string>();
let backgroundTasks: BackgroundTask[] = []; let taskPanelOpen = false;
let sourceMenuUuid = ''; let sourceMenuX = 0; let sourceMenuY = 0; const driveHealth = new Map<string, DriveHealth>();
type CopyCandidateCache = {
  filesRef: MediaFile[];
  key: string;
  files: MediaFile[];
  ids: Set<string>;
  byDay: Map<string, MediaFile[]>;
  selectedByDay: Map<string, number>;
  totalBytes: number;
};
let copyCandidateCache: CopyCandidateCache | null = null;
let copyFileIndexRef: MediaFile[] | null = null;
let copyFileIndex = new Map<string, MediaFile>();
let copySelectedBytes = 0;
const copySelectedByDay = new Map<string, number>();
let copyDaysInitializedForKey = '';
const knownCopyStatuses = new Map<string, string>();
const knownBackgroundStatuses = new Map<string, string>();

const commonExtensions = ['.mov', '.mp4', '.mxf', '.r3d', '.braw', '.wav', '.jpg', '.dng'];
type PresetDefinition = Pick<CopyPreset, 'id' | 'name' | 'extensions' | 'dateMode' | 'repositoryId' | 'pathTemplate' | 'note' | 'mode' | 'destinationMode'> & { description: string; builtIn: boolean; startDate?: string; endDate?: string };
const builtInPresets: PresetDefinition[] = [
  { id: 'builtin-today-all', name: '今日全部素材', description: '今天拍摄的所有文件', extensions: [], dateMode: 'today', repositoryId: '', destinationMode: 'default', pathTemplate: '%day/%note', note: '', mode: 'flat', builtIn: true },
  { id: 'builtin-today-video', name: '今日视频', description: '今天的 MOV、MP4、MXF、R3D 与 BRAW', extensions: ['.mov', '.mp4', '.mxf', '.r3d', '.braw'], dateMode: 'today', repositoryId: '', destinationMode: 'default', pathTemplate: '%day/%note', note: '', mode: 'flat', builtIn: true },
  { id: 'builtin-all-dng', name: '全部 DNG', description: '当前素材源中的所有 DNG', extensions: ['.dng'], dateMode: 'all', repositoryId: '', destinationMode: 'default', pathTemplate: '%day/%note', note: '', mode: 'flat', builtIn: true },
  { id: 'builtin-all-mov', name: '全部 MOV', description: '当前素材源中的所有 MOV', extensions: ['.mov'], dateMode: 'all', repositoryId: '', destinationMode: 'default', pathTemplate: '%day/%note', note: '', mode: 'flat', builtIn: true }
];
const chartColors = ['#4d8df7', '#8b6ce4', '#2fb59a', '#ef9a3c', '#e85f74', '#66a94f', '#47a8c9', '#9c6c4b'];
const icons: Record<string, string> = {
  folder: '<path d="M3 7h7l2 2h9v10H3V7Z"/>', drive: '<path d="M5 4h14v16H5V4Zm3 11h8M9 8h6m2 9h.01"/>',
  map: '<path d="m4 6 5-2 6 2 5-2v14l-5 2-6-2-5 2V6Zm5-2v14m6-12v14"/>', media: '<path d="M4 5h16v14H4V5Zm4 0v14m8-14v14M4 9h4m8 0h4M4 15h4m8 0h4"/>',
  chart: '<path d="M5 19V9m7 10V5m7 14v-7"/>', plus: '<path d="M12 5v14M5 12h14"/>', play: '<path d="m9 6 9 6-9 6V6Z"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>', list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  tree: '<path d="M6 4v16m0-12h5m-5 8h5m0-11v6h7m-7 2v6h7"/>', copy: '<rect x="7" y="7" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  storage: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
  back: '<path d="m15 18-6-6 6-6"/>', pause: '<path d="M9 5v14m6-14v14"/>', tasks: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  eye: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/>', trash: '<path d="M4 7h16m-10-3h4l1 3M7 7l1 13h8l1-13M10 11v5m4-5v5"/>', check: '<path d="m5 12 4 4L19 6"/>',
  photo: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m5 18 5-5 3 3 2-2 4 4"/>',
  audio: '<path d="M4 14v-4m4 7V7m4 13V4m4 13V7m4 7v-4"/>',
  file: '<path d="M6 3h8l4 4v14H6V3Zm8 0v5h5"/>',
  activity: '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
  shield: '<path d="M12 3 5 6v5c0 4.6 2.8 8.2 7 10 4.2-1.8 7-5.4 7-10V6l-7-3Z"/>',
  warning: '<path d="M12 4 3 20h18L12 4Zm0 6v4m0 3h.01"/>'
};
const svg = (name: string) => `<svg viewBox="0 0 24 24">${icons[name]}</svg>`;
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!);
function formatBytes(value = 0) { if (!value) return '0 B'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4); return `${(value / 1024 ** index).toFixed(index > 2 ? 2 : 1)} ${units[index]}`; }
const formatRate = (value = 0) => value < 1024 ? '0 KB/s' : `${formatBytes(value)}/s`;
function formatDate(value?: string | null) { return value ? new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '从未运行'; }
function localDay(value: string) { const d = new Date(value); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function showToast(message: string, type: 'success' | 'error' = 'success') { let toast = document.querySelector<HTMLDivElement>('.toast'); if (!toast) { toast = document.createElement('div'); toast.className = 'toast'; document.body.appendChild(toast); } toast.textContent = message; toast.dataset.type = type; toast.classList.add('visible'); clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toast?.classList.remove('visible'), 3500); }
function currentDrive() { return drives.find((drive) => drive.uuid === selectedSourceUuid); }
function sourceRecord(uuid: string) { return state.catalog.sources.find((source) => source.uuid === uuid); }
function sourceTask(drive: Drive) { return backgroundTasks.find((task) => task.kind === 'scan' && ['running', 'paused'].includes(task.status) && task.detail.startsWith(drive.name)); }
function driveHealthMarkup(health?: DriveHealth) { if (!health) return '<strong>正在读取磁盘健康信息…</strong>'; return `<strong>${escapeHtml(health.message || 'SMART 状态未知')}</strong><span>温度：${health.temperatureC == null ? '系统未提供' : `${health.temperatureC.toFixed(0)}°C`}</span><span>累计读取：${health.bytesRead == null ? '系统未提供' : formatBytes(health.bytesRead)}</span><span>累计写入：${health.bytesWritten == null ? '系统未提供' : formatBytes(health.bytesWritten)}</span><span>通电时间：${health.powerOnHours == null ? '系统未提供' : `${health.powerOnHours} 小时`}</span><small>${escapeHtml(health.protocol || '连接协议未知')}</small>`; }

function indexedFiles(sourceOnly = false): MediaFile[] {
  const start = filterStart ? new Date(`${filterStart}T00:00:00`) : null; const end = filterEnd ? new Date(`${filterEnd}T23:59:59.999`) : null;
  return state.catalog.files.filter((file) => (!sourceOnly || file.sourceUuid === selectedSourceUuid) && (!filterExtension || file.extension === filterExtension)
    && (!start || new Date(file.capturedAt) >= start) && (!end || new Date(file.capturedAt) <= end))
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

function sourceRows() {
  if (!drives.length) return '<div class="pane-empty">未检测到可用磁盘</div>';
  return drives.map((drive) => { const record = sourceRecord(drive.uuid); const task = sourceTask(drive); const indexed = state.catalog.files.filter((file) => file.sourceUuid === drive.uuid).length; const repositoryOnly = Boolean(record?.repositoryOnly); const indexStatus = repositoryOnly ? '储存盘 · 不扫描' : task ? (task.status === 'paused' ? '扫描已暂停' : '正在扫描文件') : indexed ? `已扫描 ${indexed} 个文件` : '尚未扫描'; return `<button class="source-row ${activeView === 'source' && selectedSourceUuid === drive.uuid ? 'selected' : ''} ${repositoryOnly ? 'repository-only' : ''} ${!drive.active ? 'permission-required' : ''}" data-source-uuid="${escapeHtml(drive.uuid)}" aria-haspopup="menu">${svg(repositoryOnly ? 'storage' : 'drive')}<span><strong>${escapeHtml(drive.name)}${repositoryOnly ? '<b>储存</b>' : ''}<em class="source-activation ${drive.active ? 'active' : 'inactive'}" data-source-activation><i></i>${drive.active ? '已激活' : '需授权'}</em></strong><small data-source-status>${escapeHtml(indexStatus)} · ${escapeHtml(drive.uuid.slice(0, 12))}</small></span><aside class="source-health" data-health-uuid="${escapeHtml(drive.uuid)}">${driveHealthMarkup(driveHealth.get(drive.uuid))}</aside></button>`; }).join('');
}

function updateSourceStatuses() { for (const drive of drives) { const row = document.querySelector<HTMLElement>(`[data-source-uuid="${CSS.escape(drive.uuid)}"]`); const label = row?.querySelector<HTMLElement>('[data-source-status]'); const activation = row?.querySelector<HTMLElement>('[data-source-activation]'); if (!label || !activation) continue; const repositoryOnly = Boolean(sourceRecord(drive.uuid)?.repositoryOnly); const task = sourceTask(drive); const indexed = state.catalog.files.filter((file) => file.sourceUuid === drive.uuid).length; const indexStatus = repositoryOnly ? '储存盘 · 不扫描' : task ? (task.status === 'paused' ? '扫描已暂停' : '正在扫描文件') : indexed ? `已扫描 ${indexed} 个文件` : '尚未扫描'; label.textContent = `${indexStatus} · ${drive.uuid.slice(0, 12)}`; activation.classList.toggle('active', Boolean(drive.active)); activation.classList.toggle('inactive', !drive.active); activation.lastChild!.textContent = drive.active ? '已激活' : '需授权'; row?.classList.toggle('permission-required', !drive.active); } }

function sourceContextMenu() { if (!sourceMenuUuid) return ''; const drive = drives.find((item) => item.uuid === sourceMenuUuid); if (!drive) return ''; const repositoryOnly = Boolean(sourceRecord(drive.uuid)?.repositoryOnly); const activeIndex = Boolean(sourceTask(drive)); return `<div class="source-context-menu" role="menu" style="left:${sourceMenuX}px;top:${sourceMenuY}px"><div><strong>${escapeHtml(drive.name)}</strong><small>${escapeHtml(drive.active ? '磁盘已激活' : '等待访问授权')}</small></div><button data-source-action="reload">重载磁盘状态</button><button data-source-action="rescan" ${repositoryOnly ? 'disabled' : ''}>重新扫描</button><button data-source-action="cancel" ${activeIndex ? '' : 'disabled'}>取消扫描</button><span></span><button data-source-action="repository">${repositoryOnly ? '取消标记为储存盘' : '标记为储存盘'}</button><button data-source-action="eject" class="danger">卸载磁盘…</button></div>`; }

function driveMonitor() { return drives.length ? `<section class="drive-monitor"><div class="monitor-title"><span>磁盘活动</span><i>实时</i></div>${drives.map((drive) => `<div class="monitor-row" data-speed-id="${escapeHtml(drive.id)}"><span class="monitor-dot"></span><strong>${escapeHtml(drive.name)}</strong><small><b class="read-speed">↓ ${formatRate(drive.readBps)}</b><b class="write-speed">↑ ${formatRate(drive.writeBps)}</b></small></div>`).join('')}</section>` : ''; }
function updateDriveSpeeds() { for (const drive of drives) { const row = document.querySelector<HTMLElement>(`[data-speed-id="${CSS.escape(drive.id)}"]`); if (!row) continue; row.querySelector<HTMLElement>('.read-speed')!.textContent = `↓ ${formatRate(drive.readBps)}`; row.querySelector<HTMLElement>('.write-speed')!.textContent = `↑ ${formatRate(drive.writeBps)}`; } }

function extensionClass(extension: string) { const video = ['.mov', '.mp4', '.mxf', '.avi', '.mkv', '.r3d', '.braw']; const audio = ['.wav', '.mp3', '.aac', '.flac']; const raw = ['.dng', '.cr2', '.cr3', '.nef', '.arw']; const image = ['.jpg', '.jpeg', '.png', '.tif', '.tiff']; return video.includes(extension) ? 'video' : audio.includes(extension) ? 'audio' : raw.includes(extension) ? 'raw' : image.includes(extension) ? 'image' : 'other'; }
function mediaGlyph(extension: string) { const kind = extensionClass(extension); return kind === 'video' ? 'play' : kind === 'audio' ? 'audio' : kind === 'raw' || kind === 'image' ? 'photo' : 'file'; }
function mediaPlaceholder(extension: string, className = 'media-placeholder') { const kind = extensionClass(extension); const label = ({ video: '视频', audio: '音频', raw: 'RAW 图像', image: '图像', other: '文件' } as const)[kind]; return `<i class="${className} ${kind}" title="${label}" aria-label="${label}">${svg(mediaGlyph(extension))}</i>`; }
function fileTypeBadge(extension: string) { const type = extensionClass(extension); return `<span class="file-type-badge ${type}" title="${escapeHtml(extension.slice(1).toUpperCase() || '文件')}">${escapeHtml(extension.slice(1).toUpperCase() || '文件')}</span>`; }
function fileTypeMarkup(file: MediaFile) { return `<span class="media-thumbnail file-type-mark">${fileTypeBadge(file.extension)}</span>`; }
const thumbnailMarkup = fileTypeMarkup;

async function loadRaw(relative = '') { const drive = currentDrive(); if (!drive) return; rawBusy = true; rawPath = relative; render(); try { rawEntries = await window.materialGater.listDirectory(drive.path, relative); } catch (error) { rawEntries = []; showToast(String(error), 'error'); } rawBusy = false; render(); }
function rawExplorer() { const drive = currentDrive(); if (!drive) return '<div class="list-empty">素材源已离线</div>'; const parent = rawPath.split(/[\\/]/).slice(0, -1).join('/'); return `<div class="raw-browser"><div class="raw-path"><button id="raw-back" ${!rawPath ? 'disabled' : ''}>${svg('back')}</button><span>${escapeHtml(drive.path)}${rawPath ? ` / ${escapeHtml(rawPath)}` : ''}</span><button id="raw-scan">扫描此磁盘</button></div>${rawBusy ? '<div class="list-empty">读取目录…</div>' : `<div class="raw-head"><span>名称</span><span>修改时间</span><span>大小</span></div>${rawEntries.map((entry) => `<div class="raw-row" data-raw-path="${escapeHtml(entry.path)}" data-raw-relative="${escapeHtml(entry.relativePath)}" data-directory="${entry.directory}">${entry.directory ? `<span class="raw-icon folder">${svg('folder')}</span>` : mediaPlaceholder(entry.extension, 'raw-type-icon')}<strong>${escapeHtml(entry.name)}</strong><span>${new Date(entry.modifiedAt).toLocaleString('zh-CN')}</span><b>${entry.directory ? '—' : formatBytes(entry.size)}</b></div>`).join('') || '<div class="list-empty">空目录</div>'}`}</div><span hidden data-parent="${escapeHtml(parent)}"></span>`; }

function mappingSourceOnline(mapping: Pick<MappingProfile, 'source' | 'sourceUuid'>) {
  return mapping.sourceUuid
    ? drives.some((drive) => drive.uuid === mapping.sourceUuid)
    : drives.some((drive) => drive.path === mapping.source);
}
function mappingEnabled(mapping: Pick<MappingProfile, 'enabled'>) { return mapping.enabled !== false; }
function mappingStatus(mapping: MappingProfile) {
  if (!mappingEnabled(mapping)) return { title: '已关闭', detail: '映射链接已清理', className: 'disabled' };
  if (!mappingSourceOnline(mapping)) return { title: '离线', detail: '素材源离线', className: 'offline' };
  if (mapping.mounted) return { title: '已挂载', detail: formatDate(mapping.lastRun?.at), className: 'online' };
  return { title: '未挂载', detail: '等待挂载', className: '' };
}
function mappingRows() {
  if (!state.catalog.mappings.length) return '<div class="list-empty">还没有映射<br><small>新建后可随素材源自动挂载</small></div>';
  return state.catalog.mappings.map((mapping) => {
    const status = mappingStatus(mapping);
    return `<button class="mapping-row ${status.className} ${mapping.id === selectedMappingId ? 'selected' : ''}" data-mapping="${mapping.id}"><span class="mapping-symbol">${svg('map')}</span><span class="mapping-main"><strong>${escapeHtml(mapping.name)}</strong><small>${mapping.mode === 'original' ? '原始目录' : mapping.groupByDay ? '统一映射 · 按日期' : '统一映射'} · ${escapeHtml(mapping.destination)}</small></span><span class="mapping-status ${status.className}"><strong>${status.title}</strong><small>${status.detail}</small></span><span class="chevron">›</span></button>`;
  }).join('');
}
function blankMapping(): MappingInput { const drive = currentDrive() || drives[0]; return { name: `映射 ${state.catalog.mappings.length + 1}`, source: drive?.path || '', sourceUuid: drive?.uuid || '', destination: '', extensions: [...commonExtensions], startDate: '', endDate: '', mode: 'flat', groupByDay: false }; }
function currentMapping() { return editorBuffer || state.catalog.mappings.find((item) => item.id === selectedMappingId) || null; }
function mappingSourceOptions(mapping: MappingInput) {
  const available = drives.filter((drive) => !sourceRecord(drive.uuid)?.repositoryOnly);
  const options = available.map((drive) => `<option value="${escapeHtml(drive.uuid)}" ${drive.uuid === mapping.sourceUuid ? 'selected' : ''}>${escapeHtml(drive.name)} · ${escapeHtml(drive.uuid)}</option>`);
  if (mapping.sourceUuid && !available.some((drive) => drive.uuid === mapping.sourceUuid)) {
    const source = sourceRecord(mapping.sourceUuid);
    options.unshift(`<option value="${escapeHtml(mapping.sourceUuid)}" selected>${escapeHtml(source?.name || mapping.source || '素材源')} · 离线</option>`);
  }
  return options.join('') || '<option value="">未检测到素材源</option>';
}
function mappingEditor() {
  const mapping = currentMapping();
  if (!mapping) return `<section class="detail-placeholder">${svg('map')}<h2>选择一个映射</h2><button class="button primary" id="new-mapping">${svg('plus')}新建映射</button></section>`;
  const saved = mapping.id ? state.catalog.mappings.find((item) => item.id === mapping.id) : null;
  const sourceOnline = mappingSourceOnline(mapping);
  const enabled = saved ? mappingEnabled(saved) : true;
  const sourceCount = state.catalog.files.filter((file) => file.sourceUuid === mapping.sourceUuid).length;
  const status = saved ? mappingStatus(saved) : null;
  const canMount = Boolean(saved && enabled && sourceOnline);
  return `<section class="editor mapping-editor"><div class="editor-title"><div><span>${saved ? 'UUID 映射' : '新建映射'}</span><h2>${escapeHtml(mapping.name)}</h2></div>${saved ? `<div class="mapping-title-actions"><span class="mount-pill ${status!.className}">${status!.title}</span><label class="mapping-mount-toggle ${sourceOnline ? '' : 'disabled'}" title="${sourceOnline ? '关闭会清理该映射创建的链接，但保留配置' : '素材源离线后不能更改挂载状态'}"><input id="mapping-enabled" type="checkbox" ${enabled ? 'checked' : ''} ${sourceOnline ? '' : 'disabled'}><i></i><span>挂载</span></label></div>` : ''}</div><label class="field"><span>名称</span><input id="mapping-name" value="${escapeHtml(mapping.name)}"></label><div class="mapping-flow"><label class="flow-step"><span><i>1</i>素材来源</span><select id="mapping-source">${mappingSourceOptions(mapping)}</select><small>${sourceOnline ? `${sourceCount} 个已索引素材` : '素材源离线'}</small></label><div class="flow-arrow">↓</div><label class="flow-step"><span><i>2</i>链接输出位置</span><div class="path-input"><input id="mapping-destination" readonly value="${escapeHtml(mapping.destination)}"><button id="pick-destination">选择位置</button></div></label></div><div class="field"><span>目录结构</span><div class="mapping-mode-grid"><label class="${mapping.mode !== 'original' ? 'selected' : ''}"><input type="radio" name="mapping-mode" value="flat" ${mapping.mode !== 'original' ? 'checked' : ''}><i>${svg('copy')}</i><span><strong>统一映射</strong><small>所有过滤后的素材放在同一级目录</small></span><b>默认</b></label><label class="${mapping.mode === 'original' ? 'selected' : ''}"><input type="radio" name="mapping-mode" value="original" ${mapping.mode === 'original' ? 'checked' : ''}><i>${svg('tree')}</i><span><strong>原始目录</strong><small>保持素材源的相对文件夹结构</small></span></label></div></div><label class="mapping-day-toggle ${mapping.mode === 'original' ? 'disabled' : ''}"><input id="mapping-group-day" type="checkbox" ${mapping.groupByDay ? 'checked' : ''} ${mapping.mode === 'original' ? 'disabled' : ''}><i></i><span><strong>按拍摄日期分类</strong><small>在统一目录下建立 YYYY-MM-DD 日期目录</small></span></label><div class="field"><span>文件类型</span><div class="extensions">${[...new Set([...commonExtensions, ...mapping.extensions])].map((ext) => `<label><input type="checkbox" value="${ext}" ${mapping.extensions.includes(ext) ? 'checked' : ''}><span>${ext.slice(1).toUpperCase()}</span></label>`).join('')}</div></div><div class="date-grid"><label class="field"><span>开始日期</span><input id="mapping-start" type="date" value="${mapping.startDate}"></label><label class="field"><span>结束日期</span><input id="mapping-end" type="date" value="${mapping.endDate}"></label></div><div class="editor-actions">${saved ? '<button class="button danger-outline" id="delete-mapping">删除配置…</button>' : '<span></span>'}<div><button class="button" id="save-mapping">保存</button><button class="button primary" id="run-mapping" ${canMount ? '' : 'disabled'}>${svg('play')}${saved ? '立即挂载' : '保存并挂载'}</button></div></div>${deleteConfirmOpen && saved ? `<div class="delete-panel"><strong>删除“${escapeHtml(saved.name)}”</strong><p>关闭挂载可清理链接并保留配置；删除配置不可恢复。</p><div><button class="button" id="cancel-delete">取消</button><button class="button danger-outline" id="delete-config-only">仅删除配置</button><button class="button danger-solid" id="delete-with-links">删除配置与链接</button></div></div>` : ''}</section>`;
}

function statisticsDashboard() { const files = indexedFiles(); const byDay: Record<string, { count: number; size: number }> = {}; const byType: Record<string, { count: number; size: number }> = {}; let size = 0; for (const file of files) { const day = localDay(file.capturedAt); size += file.size; byDay[day] ||= { count: 0, size: 0 }; byDay[day].count++; byDay[day].size += file.size; byType[file.extension] ||= { count: 0, size: 0 }; byType[file.extension].count++; byType[file.extension].size += file.size; } const days = Object.entries(byDay).sort().slice(-14); const max = Math.max(1, ...days.map(([, value]) => value.size)); const types = Object.entries(byType).sort(([, a], [, b]) => b.size - a.size); let cursor = 0; const stops = types.map(([, item], i) => { const start = cursor; cursor += size ? item.size / size * 100 : 0; return `${chartColors[i % chartColors.length]} ${start}% ${cursor}%`; }).join(','); return `<div class="stats-dashboard"><section class="stat-cards"><article><span>在线素材</span><strong>${files.length}</strong><small>个文件</small></article><article><span>总容量</span><strong>${formatBytes(size)}</strong></article><article><span>拍摄日期</span><strong>${days.length}</strong><small>天</small></article><article><span>在线素材源</span><strong>${drives.length}</strong><small>个</small></article></section><section class="charts-grid"><article class="chart-card"><div class="chart-title"><h2>每日拍摄容量</h2></div><div class="bar-chart">${days.map(([day, item]) => `<div class="bar-column"><b>${formatBytes(item.size)}</b><div><span style="height:${Math.max(4, item.size / max * 100)}%"></span></div><small>${day.slice(5)}</small></div>`).join('')}</div></article><article class="chart-card"><div class="chart-title"><h2>文件类型占比</h2></div><div class="pie-layout"><div class="pie" style="background:conic-gradient(${stops})"><span><strong>${types.length}</strong><small>种类型</small></span></div><div class="legend">${types.slice(0, 8).map(([ext, item], i) => `<div><i style="background:${chartColors[i % chartColors.length]}"></i><strong>${ext.slice(1).toUpperCase()}</strong><span>${size ? (item.size / size * 100).toFixed(1) : 0}%</span><small>${formatBytes(item.size)}</small></div>`).join('')}</div></div></article></section></div>`; }

function repositoryTypeLabel(type: RepositoryType) { return ({ local: '本地文件', smb: 'SMB', ftp: 'FTP', sftp: 'SFTP' } as Record<RepositoryType, string>)[type]; }
function defaultRepository() { return state.catalog.repositories.find((item) => item.isDefault) || state.catalog.repositories[0]; }
function ensureCopyFileIndex() { if (copyFileIndexRef !== state.catalog.files) { copyFileIndexRef = state.catalog.files; copyFileIndex = new Map(state.catalog.files.map((file) => [file.id, file])); rebuildCopySelectionStats(); copyCandidateCache = null; } return copyFileIndex; }
function rebuildCopySelectionStats() { copySelectedBytes = 0; copySelectedByDay.clear(); const index = copyFileIndexRef === state.catalog.files ? copyFileIndex : new Map(state.catalog.files.map((file) => [file.id, file])); for (const id of [...copySelected]) { const file = index.get(id); if (!file) { copySelected.delete(id); continue; } copySelectedBytes += file.size; const day = localDay(file.capturedAt); copySelectedByDay.set(day, (copySelectedByDay.get(day) || 0) + 1); } }
function clearCopySelection() { copySelected.clear(); copySelectedBytes = 0; copySelectedByDay.clear(); copyCandidateCache?.selectedByDay.clear(); }
function setCopyFileSelected(file: MediaFile, selected: boolean) {
  const had = copySelected.has(file.id); if (had === selected) return;
  const day = localDay(file.capturedAt);
  const updateDay = (counts: Map<string, number>) => {
    const next = Math.max(0, (counts.get(day) || 0) + (selected ? 1 : -1));
    if (next) counts.set(day, next); else counts.delete(day);
  };
  if (selected) { copySelected.add(file.id); copySelectedBytes += file.size; } else { copySelected.delete(file.id); copySelectedBytes = Math.max(0, copySelectedBytes - file.size); }
  updateDay(copySelectedByDay);
  if (copyCandidateCache?.ids.has(file.id)) updateDay(copyCandidateCache.selectedByDay);
}
function replaceCopySelection(files: MediaFile[]) { clearCopySelection(); for (const file of files) setCopyFileSelected(file, true); }
function selectedCopyFiles() { const index = ensureCopyFileIndex(); return [...copySelected].map((id) => index.get(id)).filter((file): file is MediaFile => Boolean(file)); }
function insideCopyDirectory(file: MediaFile) { if (copySelectionMode !== 'directory' || !copyCustomDirectory) return true; const directory = copyCustomDirectory.replace(/[\\/]+$/, ''); return file.path === directory || file.path.startsWith(`${directory}/`) || file.path.startsWith(`${directory}\\`); }
function copyCandidateData() { const source = copySourceUuid || drives[0]?.uuid || ''; const key = [source, copySelectionMode, copyCustomDirectory, [...copyExtensions].sort().join(','), copyStart, copyEnd].join('\u0000'); if (copyCandidateCache?.filesRef === state.catalog.files && copyCandidateCache.key === key) return copyCandidateCache; const files = state.catalog.files.filter((file) => file.sourceUuid === source && insideCopyDirectory(file) && (!copyExtensions.length || copyExtensions.includes(file.extension)) && (!copyStart || localDay(file.capturedAt) >= copyStart) && (!copyEnd || localDay(file.capturedAt) <= copyEnd)); const ids = new Set<string>(); const byDay = new Map<string, MediaFile[]>(); const selectedByDay = new Map<string, number>(); let totalBytes = 0; for (const file of files) { ids.add(file.id); totalBytes += file.size; const day = localDay(file.capturedAt); const dayFiles = byDay.get(day); if (dayFiles) dayFiles.push(file); else byDay.set(day, [file]); if (copySelected.has(file.id)) selectedByDay.set(day, (selectedByDay.get(day) || 0) + 1); } copyCandidateCache = { filesRef: state.catalog.files, key, files, ids, byDay, selectedByDay, totalBytes }; if (copyDaysInitializedForKey !== key) { copyDaysInitializedForKey = key; collapsedCopyDays.clear(); [...byDay.keys()].slice(1).forEach((day) => collapsedCopyDays.add(day)); } return copyCandidateCache; }
function copyCandidates() { return copyCandidateData().files.map((file) => ({ file, checked: copySelected.has(file.id) })); }
function copyGroups() { const groups = new Map<string, MediaFile[]>(); for (const { file } of copyCandidates()) { const date = new Date(file.capturedAt); const key = `${localDay(file.capturedAt)} ${String(date.getHours()).padStart(2, '0')}:00`; if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(file); } return groups; }
function customPresetDefinitions(): PresetDefinition[] { return state.catalog.presets.map((preset) => ({ ...preset, description: `${preset.dateMode === 'today' ? '今天' : preset.dateMode === 'all' ? '全部日期' : '固定日期'} · ${preset.extensions.length ? preset.extensions.map((item) => item.slice(1).toUpperCase()).join('、') : '全部类型'}`, builtIn: false })); }
function presetLibrary() {
  const group = (title: string, presets: PresetDefinition[], removable = false) => `<section class="preset-group"><h3>${title}</h3>${presets.map((preset) => `<div class="preset-row ${activePresetId === preset.id ? 'selected' : ''}"><button data-apply-preset="${preset.id}"><span class="preset-glyph">${svg('copy')}</span><span><strong>${escapeHtml(preset.name)}</strong><small>${escapeHtml(preset.description)}</small></span></button>${removable ? `<button class="preset-delete" data-delete-preset="${preset.id}" title="删除自定义预设">×</button>` : ''}</div>`).join('') || '<p class="preset-empty">还没有自定义预设</p>'}</section>`;
  return `<aside class="preset-library"><div class="preset-title"><strong>预设</strong></div>${group('内置预设', builtInPresets)}${group('自定义预设', customPresetDefinitions(), true)}</aside>`;
}
function copyFileGroups() {
  const candidateData = copyCandidateData();
  const groups = candidateData.byDay;
  return [...groups.entries()].map(([group, files]) => {
    const selectedCount = candidateData.selectedByDay.get(group) || 0;
    const checked = Boolean(files.length) && selectedCount === files.length;
    const partly = selectedCount > 0 && !checked;
    const hours = new Map<string, MediaFile[]>(); for (const file of files) { const hour = `${String(new Date(file.capturedAt).getHours()).padStart(2, '0')}:00`; if (!hours.has(hour)) hours.set(hour, []); hours.get(hour)!.push(file); }
    const collapsed = collapsedCopyDays.has(group);
    const visible = collapsed ? [] : files.slice(0, 120);
    return `<section class="copy-date-section ${collapsed ? 'collapsed' : ''}" data-copy-day-section="${escapeHtml(group)}"><header data-copy-day-toggle="${escapeHtml(group)}" role="button" tabindex="0" aria-expanded="${collapsed ? 'false' : 'true'}" title="点击折叠或展开此日期"><label class="large-check"><input class="copy-day-check" data-copy-day="${escapeHtml(group)}" type="checkbox" ${checked ? 'checked' : ''}><i></i></label><div><strong>${escapeHtml(group)}</strong><small>${partly ? '部分选择 · ' : ''}${files.length} 个 · ${formatBytes(files.reduce((sum, file) => sum + file.size, 0))}</small></div><span class="copy-hour-chips">${[...hours.entries()].slice(0, 8).map(([hour, values]) => `<b>${hour} · ${values.length}</b>`).join('')}</span></header>${collapsed ? '' : `<div class="copy-finder-grid">${visible.map((file) => `<article class="copy-media-card ${copySelected.has(file.id) ? 'selected' : ''}" data-file-path="${escapeHtml(file.path)}" tabindex="0"><input class="copy-file-check" data-copy-id="${file.id}" type="checkbox" ${copySelected.has(file.id) ? 'checked' : ''}>${fileTypeMarkup(file)}<span><strong>${escapeHtml(file.name)}</strong><small>${new Date(file.capturedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · ${formatBytes(file.size)}</small></span><button class="media-preview" data-preview-path="${escapeHtml(file.path)}" title="使用系统组件预览">${svg('eye')}</button></article>`).join('')}</div>${files.length > visible.length ? `<p class="copy-group-more">为保持流畅，此栏显示前 120 项；勾选栏标题仍会选择全部 ${files.length} 项。</p>` : ''}`}</section>`;
  }).join('') || '<div class="list-empty">当前素材源没有符合条件的文件</div>';
}
function copyWizardHeader() {
  return `<div class="copy-modebar"><div class="copy-tabs"><button data-copy-section="create" class="${copySection === 'create' ? 'active' : ''}">新建任务</button><button data-copy-section="tasks" class="${copySection === 'tasks' ? 'active' : ''}">任务队列 <span>${state.catalog.tasks.length}</span></button></div>${copySection === 'create' ? `<div class="wizard-steps">${[1, 2, 3].map((step) => `<button data-copy-step="${step}" class="${copyStep === step ? 'active' : copyStep > step ? 'done' : ''}" ${step > copyStep ? 'disabled' : ''}><i>${copyStep > step ? '✓' : step}</i><span>${step === 1 ? '素材源与文件' : step === 2 ? '储存位置' : '复核执行'}</span></button>`).join('')}</div>` : ''}</div>`;
}
function copySelectionBrowser() {
  const candidates = copyCandidates();
  const extensions = [...new Set(state.catalog.files.filter((file) => file.sourceUuid === copySourceUuid).map((file) => file.extension))].sort();
  const selectableDrives = drives.filter((drive) => !sourceRecord(drive.uuid)?.repositoryOnly);
  const customSource = copySelectionMode === 'directory' && copyCustomDirectory;
  return `<div class="copy-selection-browser"><div class="stage-heading compact"><div><span>第一步</span><h2>选择素材源与范围</h2></div></div><section class="copy-source-choice"><div class="copy-source-choice-heading"><strong>素材源</strong><span>${customSource ? '已指定目录' : '全盘扫描'}</span></div><div class="copy-source-grid">${selectableDrives.map((drive) => `<button data-copy-source="${escapeHtml(drive.uuid)}" class="${copySelectionMode === 'grouped' && drive.uuid === copySourceUuid ? 'selected' : ''}">${svg('drive')}<span><strong>${escapeHtml(drive.name)}</strong><small>${escapeHtml(drive.path)}</small></span></button>`).join('') || '<p class="copy-source-empty">没有可用素材源</p>'}<button class="copy-directory-pick ${customSource ? 'selected' : ''}" id="copy-pick-directory">${svg('folder')}<span><strong>${customSource ? escapeHtml(copyCustomDirectory.split(/[\\/]/).pop() || copyCustomDirectory) : '指定路径'}</strong>${customSource ? `<small>${escapeHtml(copyCustomDirectory)}</small>` : ''}</span></button></div></section><div class="copy-filter-panel"><div class="copy-date-range"><label><span>开始日期</span><input id="copy-start" type="date" value="${copyStart}"></label><label><span>结束日期</span><input id="copy-end" type="date" value="${copyEnd}"></label></div><div class="copy-quick"><button id="copy-today">今天</button><button data-quick-ext=".dng">所有 DNG</button><button data-quick-ext=".mov">所有 MOV</button><button id="copy-clear-rule">清除筛选</button></div><div class="copy-types">${extensions.map((ext) => `<label><input type="checkbox" data-copy-ext="${ext}" ${copyExtensions.includes(ext) ? 'checked' : ''}><span class="${extensionClass(ext)}">${ext.slice(1).toUpperCase()}</span></label>`).join('')}</div></div><div class="copy-list-toolbar"><div><strong>${candidates.length}</strong><span>个符合条件</span></div><div><button id="copy-select-visible">全选当前结果</button><button id="copy-clear-selected">取消全部选择</button></div></div><div class="copy-files expanded finder-sections">${copySelectionMode === 'directory' && !copyCustomDirectory ? '<div class="copy-directory-empty">请选择目录</div>' : copyFileGroups()}</div></div>`;
}

function copyPickerOverlay() {
  ensureCopyFileIndex(); const selectedCount = copySelected.size;
  return `<div class="copy-picker-backdrop" data-copy-picker-backdrop><section class="copy-picker-dialog" role="dialog" aria-modal="true" aria-label="选择素材源与文件"><header class="copy-picker-header"><div><span>步骤 1</span><h2>选择素材源与文件</h2></div><button class="icon-button" id="copy-picker-close" aria-label="关闭选择窗口">×</button></header><div class="copy-picker-content">${copySelectionBrowser()}</div><footer class="wizard-footer copy-picker-footer"><div><strong data-copy-selected-count>已选 ${selectedCount} 个文件</strong><span data-copy-selected-size>${formatBytes(copySelectedBytes)}</span></div><button class="button primary large" id="copy-picker-done" ${selectedCount ? '' : 'disabled'}>完成选择</button></footer></section></div>`;
}

function copySelectionStage() {
  const candidateData = copyCandidateData(); const candidates = candidateData.files.map((file) => ({ file, checked: copySelected.has(file.id) })); const selected = selectedCopyFiles(); const selectedBytes = copySelectedBytes;
  const source = drives.find((drive) => drive.uuid === (copySourceUuid || drives[0]?.uuid));
  const filterSummary = [copyStart || copyEnd ? `${copyStart || '最早'} 至 ${copyEnd || '最新'}` : '全部日期', copyExtensions.length ? copyExtensions.map((item) => item.slice(1).toUpperCase()).join('、') : '全部类型', copySelectionMode === 'directory' ? (copyCustomDirectory ? copyCustomDirectory.split(/[\\/]/).pop() || '指定路径' : '等待指定路径') : '全盘扫描'];
  const preview = selected.slice(0, 6);
  return `<div class="copy-selection-layout">${presetLibrary()}<section class="copy-selection-workspace picker-entry"><div class="stage-heading"><div><span>步骤 1</span><h2>选择素材源与文件</h2></div><button class="button primary large" id="copy-open-picker">${svg('folder')}选择文件…</button></div><div class="copy-pick-summary"><div><span>读取范围</span><strong>${escapeHtml(source?.name || (copyCustomDirectory ? '指定路径' : '未选择素材源'))}</strong><small>${escapeHtml(filterSummary.join(' · '))}</small></div><div><span>结果</span><strong>${candidates.length} 个 · ${formatBytes(candidateData.totalBytes)}</strong></div><div><span>已选</span><strong data-copy-selected-count id="copy-selected-count">${selected.length} 个 · ${formatBytes(selectedBytes)}</strong></div></div>${preview.length ? `<div class="copy-selection-preview">${preview.map((file) => `<div><span class="extension ${extensionClass(file.extension)}">${escapeHtml(file.extension.slice(1).toUpperCase() || 'FILE')}</span><span><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.relativePath)}</small></span></div>`).join('')}${selected.length > preview.length ? `<p>另有 ${selected.length - preview.length} 个文件</p>` : ''}</div>` : `<button class="copy-selection-empty" id="copy-open-picker-empty">${svg('folder')}<span><strong>选择文件</strong></span></button>`}<footer class="wizard-footer"><div><strong data-copy-selected-count>已选 ${selected.length} 个文件</strong><span data-copy-selected-size>${formatBytes(selectedBytes)}</span></div><button class="button primary large" id="copy-next" data-copy-next ${selected.length ? '' : 'disabled'}>继续选择储存位置 →</button></footer></section></div>`;
}
function copyDestinationStage() {
  const fallback = defaultRepository(); const usingDefault = copyDestinationMode === 'default'; const destinationReady = usingDefault ? Boolean(fallback) : Boolean(copyCustomDestination);
  return `<section class="copy-stage destination-stage"><div class="stage-heading"><div><span>步骤 2</span><h2>选择储存方式</h2></div></div><div class="destination-choice"><button data-destination-mode="default" class="${usingDefault ? 'selected' : ''}"><i>${svg('storage')}</i><span><strong>默认储存</strong><small>${fallback ? `${escapeHtml(fallback.name)} · ${escapeHtml(fallback.root || fallback.address)}` : '未设置'}</small></span></button><button data-destination-mode="custom" class="${!usingDefault ? 'selected' : ''}"><i>${svg('folder')}</i><span><strong>选择文件夹…</strong>${copyCustomDestination ? `<small>${escapeHtml(copyCustomDestination)}</small>` : ''}</span></button></div>${usingDefault ? (fallback ? `<div class="default-destination-summary"><div>${svg('storage')}<span><small>默认储存位置</small><strong>${escapeHtml(fallback.name)}</strong><em>${escapeHtml(fallback.root || fallback.address)}</em></span></div><div><span><small>目录规则</small><strong>${escapeHtml(fallback.defaultPathTemplate || '目标文件夹根目录')}</strong><em>${fallback.defaultMode === 'flat' ? '统一放入目标目录' : '保留原始相对路径'}</em></span></div></div>` : `<div class="empty-callout compact"><strong>未设置默认储存位置</strong><button class="button primary" data-destination-mode="custom">选择文件夹…</button></div>`) : `<div class="custom-destination"><div class="custom-target-row"><span class="location-symbol">${svg('folder')}</span><span><small>本次目标文件夹</small><strong>${escapeHtml(copyCustomDestination.split(/[\\/]/).filter(Boolean).pop() || '尚未选择')}</strong>${copyCustomDestination ? `<em>${escapeHtml(copyCustomDestination)}</em>` : ''}</span><button class="button" id="copy-pick-destination">${copyCustomDestination ? '更改…' : '选择文件夹…'}</button></div><div class="copy-path-grid"><label class="large-field"><span>本次备注（可选）</span><input id="copy-note" value="${escapeHtml(copyNote)}" placeholder="可选"></label><label class="large-field"><span>目录模板（可选）</span><input id="copy-template" value="${escapeHtml(copyTemplate)}" placeholder="留空则存入目标文件夹"></label></div></div>`}<footer class="wizard-footer"><button class="button large" id="copy-back">← 返回选择素材</button><button class="button primary large" id="copy-next" ${destinationReady ? '' : 'disabled'}>继续复核 →</button></footer></section>`;
}
function resolvedCopyRepository() { return copyDestinationMode === 'default' ? defaultRepository() : undefined; }
function resolvedCopyTemplate() { const repository = resolvedCopyRepository(); return copyDestinationMode === 'default' ? repository?.defaultPathTemplate || '' : copyTemplate; }
function resolvedCopyMode(): 'flat' | 'original' { const repository = resolvedCopyRepository(); return copyDestinationMode === 'default' ? repository?.defaultMode || 'flat' : copyMode; }
function previewCopyPath() { const first = selectedCopyFiles()[0]; if (!first) return '—'; const template = resolvedCopyTemplate().replace(/%day/g, localDay(first.capturedAt)).replace(/%time/g, new Date(first.capturedAt).toTimeString().slice(0, 8).replace(/:/g, '-')).replace(/%note\("([^"]*)"\)/g, '$1').replace(/%note/g, copyNote).replace(/^[\\/]+|[\\/]+$/g, ''); const file = resolvedCopyMode() === 'flat' ? first.name : first.relativePath; return [template, file].filter(Boolean).join(' / '); }
function copyReviewStage() {
  const files = selectedCopyFiles(); const repository = resolvedCopyRepository(); const source = drives.find((drive) => drive.uuid === copySourceUuid);
  const destinationName = copyDestinationMode === 'custom' ? (copyCustomDestination.split(/[\\/]/).filter(Boolean).pop() || '临时目标文件夹') : repository?.name || '未选择';
  const destinationReady = copyDestinationMode === 'custom' ? Boolean(copyCustomDestination) : Boolean(repository);
  return `<section class="copy-stage review-stage"><div class="stage-heading"><div><span>步骤 3</span><h2>复核并开始拷贝</h2></div></div><div class="review-grid"><article><span>素材</span><strong>${files.length} 个文件</strong><small>${formatBytes(files.reduce((sum, file) => sum + file.size, 0))} · ${escapeHtml(source?.name || '素材源')}</small><button data-copy-step="1">修改素材</button></article><article><span>储存位置</span><strong>${escapeHtml(destinationName)}</strong><small>${escapeHtml(copyDestinationMode === 'custom' ? copyCustomDestination : repository ? `${repositoryTypeLabel(repository.type)} · ${repository.root || repository.address}` : '')}</small><button data-copy-step="2">修改位置</button></article><article class="path-preview"><span>首个文件路径预览</span><strong>${escapeHtml(previewCopyPath())}</strong><small>${resolvedCopyMode() === 'flat' ? '统一目录' : '保留原始路径'}</small></article></div><div class="preset-save-panel"><strong>保存为自定义预设</strong><input id="copy-preset-name" value="${escapeHtml(copyPresetName)}" placeholder="预设名称"><button class="button" id="save-copy-preset">保存预设</button></div><footer class="wizard-footer"><button class="button large" id="copy-back">← 返回储存位置</button><button class="button primary large" id="start-copy" ${files.length && destinationReady ? '' : 'disabled'}>${svg('copy')}开始后台拷贝</button></footer></section>`;
}
const taskStatusLabels: Record<string, string> = { running: '进行中', processing: '传输与校验中', verifying: '校验中', queued: '等待中', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消' };
const taskFinished = (status: string) => ['completed', 'failed', 'cancelled'].includes(status);
function taskStatusLabel(status: string) { return taskStatusLabels[status] || status || '等待中'; }
function copyTaskTransferredBytes(task: AppState['catalog']['tasks'][number]) { return task.status === 'verifying' || task.status === 'completed' ? task.totalBytes : task.copiedBytes; }
function copyTaskOverallProgress(task: AppState['catalog']['tasks'][number]) { const total = Math.max(1, task.totalBytes); return Math.min(100, ((Math.min(copyTaskTransferredBytes(task), total) + Math.min(task.verifiedBytes || 0, total)) / (total * 2)) * 100); }
function copyTaskDisplayStatus(task: AppState['catalog']['tasks'][number]) { if (task.status === 'failed' || task.verifyStatus === 'failed') return 'failed'; if (task.status === 'completed' && task.verifyStatus === 'completed') return 'completed'; if (task.status === 'paused') return 'paused'; if (task.status === 'running' && task.verifyStatus === 'running') return 'processing'; if (task.status === 'verifying' || task.verifyStatus === 'running') return 'verifying'; return task.status || 'queued'; }
function progressRing(progress: number | null, status: string, center = '') { const value = Math.max(0, Math.min(100, progress ?? 26)); const indeterminate = progress == null && ['running', 'processing', 'queued', 'verifying'].includes(status); return `<span class="progress-ring ${status} ${indeterminate ? 'indeterminate' : ''}" aria-hidden="true"><svg viewBox="0 0 36 36"><circle class="ring-track" cx="18" cy="18" r="14"/><circle class="ring-value" pathLength="100" stroke-dasharray="${value} 100" cx="18" cy="18" r="14"/></svg>${center ? `<b>${escapeHtml(center)}</b>` : ''}</span>`; }
function friendlyTaskError(value: string) { if (!value) return ''; if (/ENOSPC|no space left on device/i.test(value)) return '目标磁盘空间不足。任务已停止；已复制文件和断点数据均保留。'; return value.replace(/^Error:\s*/i, ''); }
function etaLabel(eta: number | null) { return eta == null ? '预计时间 —' : `预计 ${Math.floor(eta / 60)}:${String(eta % 60).padStart(2, '0')}`; }
function taskQueue() { const tasks = state.catalog.tasks; const finished = tasks.filter((task) => taskFinished(copyTaskDisplayStatus(task))).length; return `<section class="copy-task-queue"><div class="stage-heading"><div><span>后台任务</span><h2>拷贝与校验队列</h2></div><div class="queue-actions">${finished ? `<button class="button" id="clear-copy-finished">${svg('trash')}清理已结束（${finished}）</button>` : ''}<button class="button primary" data-copy-section="create">${svg('plus')}新建拷贝任务</button></div></div><div class="task-grid">${tasks.map((task) => taskCard(task)).join('') || '<div class="empty-callout"><strong>暂无拷贝任务</strong><button class="button primary" data-copy-section="create">新建任务</button></div>'}</div></section>`; }
function copyWorkspace() { return `<div class="copy-wizard">${copyWizardHeader()}${copySection === 'tasks' ? taskQueue() : copyStep === 1 ? copySelectionStage() : copyStep === 2 ? copyDestinationStage() : copyReviewStage()}</div>`; }
function pipelineLane(icon: string, title: string, status: string, current: number, total: number, speed: number, eta: number | null, history: number[], detail: string) { const progress = total ? Math.min(100, current / total * 100) : 0; const max = Math.max(1, ...history); const bars = history.slice(-18); return `<section class="task-lane"><span class="task-stage-symbol ${status}">${svg(status === 'completed' ? 'check' : icon)}</span><div class="task-stage-body"><header><strong>${title}</strong><span class="task-status ${status}">${taskStatusLabel(status)}</span></header><div class="progress"><i style="width:${progress}%"></i></div><div class="task-meta"><strong>${progress.toFixed(1)}%</strong><span>${formatBytes(current)} / ${formatBytes(total)}</span><span>${formatRate(speed)}</span><span>${etaLabel(eta)}</span></div>${detail ? `<p class="task-error">${escapeHtml(friendlyTaskError(detail))}</p>` : ''}</div><div class="task-sparkline" aria-hidden="true">${bars.map((value) => `<i style="height:${Math.max(3, value / max * 100)}%"></i>`).join('')}</div></section>`; }
function taskCard(task: AppState['catalog']['tasks'][number]) { const verified = task.verifiedBytes || 0; const status = copyTaskDisplayStatus(task); const active = ['running', 'processing', 'verifying', 'queued'].includes(status); const terminal = taskFinished(status); const transferComplete = task.status === 'verifying' || task.status === 'completed'; const transferStatus = transferComplete ? 'completed' : task.status; const transferred = copyTaskTransferredBytes(task); const transferSpeed = transferComplete ? 0 : task.speed; const transferEta = transferComplete ? 0 : task.eta; const verifyStatus = task.verifyStatus || (task.status === 'completed' ? 'completed' : 'queued'); const actions = active ? `<button class="task-action prominent" data-pause-task="${task.id}">${svg('pause')}暂停</button>` : status === 'paused' ? `<button class="task-action prominent" data-resume-task="${task.id}">${svg('play')}继续</button>` : status === 'failed' ? `<button class="task-action prominent" data-resume-task="${task.id}">${svg('play')}重试</button>` : ''; return `<article class="task-card ${status}"><header class="task-title">${progressRing(copyTaskOverallProgress(task), status, status === 'completed' ? '✓' : '')}<div><strong>${escapeHtml(task.name)}</strong><small>${formatDate(task.createdAt)} · ${task.files.length} 个文件 · ${formatBytes(task.totalBytes)}</small></div><span class="task-overall-status ${status}">${taskStatusLabel(status)}</span><div class="task-card-actions">${actions}${terminal ? `<button class="task-action icon danger" data-dismiss-copy-task="${task.id}" title="清理任务记录" aria-label="清理任务记录">${svg('trash')}</button>` : ''}</div></header><div class="task-pipelines">${pipelineLane('copy', '传输', transferStatus, transferred, task.totalBytes, transferSpeed, transferEta, task.history, task.error || '')}${pipelineLane('shield', 'BLAKE3 校验', verifyStatus, verified, task.totalBytes, task.verifySpeed || 0, task.verifyEta ?? null, task.verifyHistory || [], task.verifyError || '')}</div></article>`; }

function repositoryWorkspace() { const current = repositoryDraft || state.catalog.repositories.find((item) => item.id === selectedRepositoryId); return `<div class="repository-page"><section class="repository-list"><div class="section-heading"><div><h2>储存位置</h2><span>${state.catalog.repositories.length} 个位置</span></div><button class="button" id="new-repository" aria-label="新建储存位置">${svg('plus')}<span>新建</span></button></div>${state.catalog.repositories.map((repo) => `<button class="repository-row ${repo.id === selectedRepositoryId && !repositoryDraft ? 'selected' : ''}" data-repository="${repo.id}">${svg('storage')}<span><strong>${escapeHtml(repo.name)}${repo.isDefault ? '<i>默认</i>' : ''}</strong><small>${repositoryTypeLabel(repo.type)} · ${escapeHtml(repo.root || repo.address)}</small></span></button>`).join('')}</section><aside class="repository-editor">${current ? repositoryForm(current) : `<div class="detail-placeholder">${svg('storage')}<h2>添加储存位置</h2><button class="button primary" id="empty-repository">${svg('plus')}添加储存位置</button></div>`}</aside></div>`; }
function repositoryForm(repo: Partial<Repository>) {
  const type = repo.type || 'local'; const remote = ['smb', 'ftp', 'sftp'].includes(type);
  const typeOptions: Array<{ type: RepositoryType; title: string; detail: string }> = [{ type: 'local', title: '本地文件', detail: '内置盘、USB 硬盘或已挂载目录' }, { type: 'smb', title: 'SMB', detail: 'NAS 与 Windows 文件共享' }, { type: 'ftp', title: 'FTP', detail: '标准 FTP 文件服务器' }, { type: 'sftp', title: 'SFTP', detail: '基于 SSH 的安全文件传输' }];
  const localPath = repo.root || '';
  const localName = localPath.split(/[\\/]/).filter(Boolean).pop() || '尚未选择目录';
  return `<section class="repository-form"><div class="editor-title"><div><span>储存位置配置</span><h2>${escapeHtml(repo.name || '新储存位置')}</h2></div>${repo.isDefault ? '<span class="default-badge">默认储存</span>' : ''}</div><section class="form-section"><h3>基本信息</h3><label class="large-field"><span>显示名称</span><input id="repo-name" value="${escapeHtml(repo.name || '')}" placeholder="例如：剪辑素材主库"></label><div class="repository-type-grid">${typeOptions.map((item) => `<button data-repo-type="${item.type}" class="${type === item.type ? 'selected' : ''}">${svg(item.type === 'local' ? 'folder' : 'storage')}<span><strong>${item.title}</strong><small>${item.detail}</small></span></button>`).join('')}</div></section><section class="form-section"><h3>${remote ? '连接与鉴权' : '文件位置'}</h3>${type === 'local' ? `<input id="repo-root" type="hidden" value="${escapeHtml(localPath)}"><div class="location-picker ${localPath ? 'selected' : ''}"><span class="location-symbol">${svg('folder')}</span><span class="location-copy"><small>储存目录</small><strong>${escapeHtml(localName)}</strong><em>${escapeHtml(localPath || '选择本地目录或外置硬盘')}</em></span><button id="pick-repo-root">${localPath ? '更改…' : '选择目录…'}</button></div><p class="form-help">这里只保存目录引用；更改或删除此配置都不会移动、覆盖或删除目录中的素材。</p>` : `<label class="large-field"><span>${type === 'smb' ? '共享地址' : '服务器地址'}</span><input id="repo-address" value="${escapeHtml(repo.address || '')}" placeholder="${type === 'smb' ? '\\\\server\\share' : 'server.example.com'}"></label><div class="repo-two-column"><label class="large-field"><span>端口</span><input id="repo-port" type="number" value="${repo.port || (type === 'sftp' ? 22 : type === 'ftp' ? 21 : 445)}"></label><label class="large-field"><span>远程目录</span><input id="repo-remote-path" value="${escapeHtml(repo.remotePath || '')}" placeholder="/media"></label><label class="large-field"><span>用户名</span><input id="repo-username" value="${escapeHtml(repo.username || '')}"></label><label class="large-field"><span>域名称${type === 'smb' ? '' : '（可选）'}</span><input id="repo-domain" value="${escapeHtml(repo.domain || '')}"></label></div><label class="large-field"><span>密码${repo.hasPassword ? '（已安全保存，留空保持不变）' : ''}</span><input id="repo-password" type="password" autocomplete="new-password"></label><p class="form-help">密码通过系统安全存储加密，不会写入普通配置文件。</p>`}</section><section class="form-section defaults-section"><div><h3>默认拷贝规则</h3></div><label class="default-toggle"><input id="repo-default" type="checkbox" ${repo.isDefault ? 'checked' : ''}><i></i><span><strong>设为默认储存位置</strong></span></label><label class="large-field"><span>默认目录模板</span><input id="repo-default-template" value="${escapeHtml(repo.defaultPathTemplate || '%day/%note')}"><small>变量：%day、%time、%note</small></label><div class="copy-options roomy"><label><input type="radio" name="repo-default-mode" value="flat" ${(repo.defaultMode || 'flat') === 'flat' ? 'checked' : ''}>统一放入目标目录</label><label><input type="radio" name="repo-default-mode" value="original" ${repo.defaultMode === 'original' ? 'checked' : ''}>保留原始相对路径</label></div></section><div class="editor-actions">${repo.id ? '<button class="button danger-outline" id="delete-repository">删除位置…</button>' : '<span></span>'}<div><button class="button" id="test-repository">测试连接</button><button class="button primary" id="save-repository">保存储存位置</button></div></div></section>`;
}

function settingsWorkspace() {
  const settings = state.catalog.settings;
  const title = (icon: string, name: string) => `<div class="settings-title"><span class="settings-symbol">${svg(icon)}</span><h2>${name}</h2></div>`;
  return `<div class="settings-page"><section class="settings-primary">${title('activity', '检测与后台')}<div class="settings-row"><strong>前台扫描频率</strong><select id="foreground-frequency">${[500, 1000, 2000, 5000].map((ms) => `<option value="${ms}" ${settings.foregroundScanMs === ms ? 'selected' : ''}>${ms / 1000} 秒</option>`).join('')}</select></div><div class="settings-row"><strong>后台扫描频率</strong><select id="background-frequency">${[1000, 3000, 5000, 10000].map((ms) => `<option value="${ms}" ${settings.backgroundScanMs === ms ? 'selected' : ''}>${ms / 1000} 秒</option>`).join('')}</select></div><label class="settings-toggle"><strong>检测后询问是否扫描</strong><input id="ask-scan" type="checkbox" ${settings.askBeforeScan ? 'checked' : ''}><i></i></label><label class="settings-toggle"><strong>系统通知</strong><input id="notifications" type="checkbox" ${settings.notifications ? 'checked' : ''}><i></i></label><label class="settings-toggle"><strong>关闭窗口后继续运行</strong><input id="keep-running" type="checkbox" ${settings.keepRunning ? 'checked' : ''}><i></i></label><div class="settings-subheading"><strong>阻止系统休眠</strong></div><label class="settings-toggle"><strong>拷贝与校验期间</strong><input id="prevent-sleep-copy" type="checkbox" ${settings.preventSleepCopy ? 'checked' : ''}><i></i></label><label class="settings-toggle"><strong>文件扫描期间</strong><input id="prevent-sleep-scan" type="checkbox" ${settings.preventSleepScan ? 'checked' : ''}><i></i></label><label class="settings-toggle"><strong>映射挂载期间</strong><input id="prevent-sleep-mapping" type="checkbox" ${settings.preventSleepMapping ? 'checked' : ''}><i></i></label><label class="settings-toggle"><strong>应用运行期间</strong><input id="prevent-sleep-app" type="checkbox" ${settings.preventSleepApp ? 'checked' : ''}><i></i></label><div class="settings-actions"><button class="button primary" id="save-settings">保存设置</button></div></section><div class="settings-side"><section>${title('folder', '本地数据')}<button class="data-card" id="open-data"><span class="data-card-symbol">${svg('folder')}</span><span><strong>${escapeHtml(state.dataDirectory)}</strong><em>在 Finder 中显示</em></span></button></section></div></div>`;
}

function filterControls() { if (activeView !== 'activity') return ''; const extensions = [...new Set(state.catalog.files.map((file) => file.extension))].sort(); return `<select id="filter-extension"><option value="">全部类型</option>${extensions.map((ext) => `<option value="${ext}" ${filterExtension === ext ? 'selected' : ''}>${ext.slice(1).toUpperCase()}</option>`).join('')}</select><label class="date-filter">从 <input id="filter-start" type="date" value="${filterStart}"></label><label class="date-filter">至 <input id="filter-end" type="date" value="${filterEnd}"></label><button class="button" id="export-statistics">导出数据</button>`; }
function viewTitle() { const labels: Record<View, string> = { mappings: '映射', activity: '统计', copy: '拷贝', repositories: '储存位置', settings: '设置', source: currentDrive()?.name || '素材源' }; const subtitles: Record<View, string> = { mappings: `${state.catalog.mappings.length} 个`, activity: `${state.stats.count} 个文件 · ${formatBytes(state.stats.size)}`, copy: `${state.catalog.tasks.length} 个任务`, repositories: `${state.catalog.repositories.length} 个`, settings: '', source: currentDrive()?.path || '' }; return { title: labels[activeView], subtitle: subtitles[activeView] }; }

function mainContent() { if (activeView === 'mappings') return `<div class="work-area"><section class="list-pane">${mappingRows()}</section><aside class="detail-pane">${mappingEditor()}</aside></div>`; if (activeView === 'source') return `<div class="single-pane">${rawExplorer()}</div>`; if (activeView === 'activity') return `<div class="single-pane">${statisticsDashboard()}</div>`; if (activeView === 'copy') return `<div class="single-pane">${copyWorkspace()}</div>`; if (activeView === 'repositories') return `<div class="single-pane">${repositoryWorkspace()}</div>`; return `<div class="single-pane">${settingsWorkspace()}</div>`; }

function taskCenterMarkup() {
  type CenterTask = { id: string; title: string; detail: string; status: string; progress: number | null; updatedAt: string; kind: 'background' | 'copy'; openCopy: boolean; pause: boolean; resume: boolean; dismiss: boolean };
  const runtime: CenterTask[] = backgroundTasks.map((task) => ({ id: task.id, title: task.title, detail: friendlyTaskError(task.error || task.detail), status: task.status, progress: task.total ? Math.min(100, task.current / task.total * 100) : null, updatedAt: task.updatedAt, kind: 'background', openCopy: false, pause: task.status === 'running', resume: task.status === 'paused', dismiss: taskFinished(task.status) }));
  const copies: CenterTask[] = state.catalog.tasks.map((task) => { const status = copyTaskDisplayStatus(task); const transfer = task.totalBytes ? Math.min(100, copyTaskTransferredBytes(task) / task.totalBytes * 100) : 0; const verify = task.totalBytes ? Math.min(100, (task.verifiedBytes || 0) / task.totalBytes * 100) : 0; return { id: task.id, title: task.name, detail: `传输 ${transfer.toFixed(0)}% · 校验 ${verify.toFixed(0)}% · ${task.files.length} 个文件`, status, progress: copyTaskOverallProgress(task), updatedAt: task.updatedAt, kind: 'copy', openCopy: true, pause: ['running', 'processing', 'queued', 'verifying'].includes(status), resume: ['paused', 'failed'].includes(status), dismiss: taskFinished(status) }; });
  const allTasks = [...runtime, ...copies].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const tasks = allTasks;
  const activeTasks = allTasks.filter((task) => ['running', 'processing', 'queued', 'verifying'].includes(task.status));
  const pausedTasks = allTasks.filter((task) => task.status === 'paused');
  const active = activeTasks.length;
  const failed = allTasks.filter((task) => task.status === 'failed').length;
  const finished = allTasks.filter((task) => task.dismiss).length;
  const aggregate = activeTasks.length ? activeTasks.reduce((sum, task) => sum + (task.progress ?? 0), 0) / activeTasks.length : pausedTasks.length ? pausedTasks.reduce((sum, task) => sum + (task.progress ?? 0), 0) / pausedTasks.length : failed || finished ? 100 : 0;
  const buttonStatus = active ? 'running' : failed ? 'failed' : pausedTasks.length ? 'paused' : finished ? 'completed' : 'idle';
  const rows = tasks.map((task) => { const action = task.pause ? `<button class="task-inline-action" data-pause-${task.kind}="${task.id}" title="暂停" aria-label="暂停任务">${svg('pause')}</button>` : task.resume ? `<button class="task-inline-action" data-resume-${task.kind}="${task.id}" title="${task.status === 'failed' ? '重试' : '继续'}" aria-label="${task.status === 'failed' ? '重试任务' : '继续任务'}">${svg('play')}</button>` : ''; const dismiss = task.dismiss ? `<button class="task-inline-action danger" data-dismiss-${task.kind}="${task.id}" data-task-title="${escapeHtml(task.title)}" title="清理任务记录" aria-label="清理任务记录">${svg('trash')}</button>` : ''; return `<article class="task-center-row ${task.status}" data-task-copy="${task.openCopy}">${progressRing(task.progress, task.status)}<button class="task-row-main" ${task.openCopy ? 'data-show-copy-queue="true"' : 'disabled'}><span><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.detail)}</small><em><b>${taskStatusLabel(task.status)}</b>${task.progress == null ? '进度计算中' : `${task.progress.toFixed(0)}%`}</em></span></button><span class="task-row-actions">${action}${dismiss}</span></article>`; }).join('');
  const summary = active ? `${active} 个任务正在运行${failed ? ` · ${failed} 个需处理` : ''}` : failed ? `${failed} 个失败任务需处理` : pausedTasks.length ? `${pausedTasks.length} 个任务已暂停` : finished ? `${finished} 个任务已结束` : '当前没有后台任务';
  const ringLabel = active ? (active > 9 ? '9+' : String(active)) : failed ? '!' : pausedTasks.length ? 'Ⅱ' : finished ? '✓' : '';
  return `<button id="task-center-button" class="task-center-button ${buttonStatus}" title="${escapeHtml(summary)}" aria-label="后台任务：${escapeHtml(summary)}" aria-expanded="${taskPanelOpen}">${progressRing(aggregate, buttonStatus, ringLabel)}</button>${taskPanelOpen ? `<section class="task-popover" role="dialog" aria-label="后台任务"><header><div><strong>后台任务</strong><span>${escapeHtml(summary)}</span></div><button id="task-center-close" aria-label="关闭">×</button></header><div class="task-center-list">${rows || '<div class="task-center-empty">暂无任务</div>'}</div>${finished ? `<footer><span>只移除任务记录，不会删除文件或已复制内容。</span><button id="clear-finished-all">${svg('trash')}清理已结束</button></footer>` : ''}</section>` : ''}`;
}

function bindTaskCenter() {
  const taskCenterButton = document.querySelector<HTMLButtonElement>('#task-center-button');
  document.querySelector<HTMLElement>('.task-popover')?.addEventListener('pointerdown', (event) => event.stopPropagation());
  taskCenterButton?.addEventListener('pointerdown', (event) => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); taskPanelOpen = !taskPanelOpen; updateTaskCenter(); });
  taskCenterButton?.addEventListener('click', (event) => { if (event.detail !== 0) return; taskPanelOpen = !taskPanelOpen; updateTaskCenter(); });
  const taskCenterClose = document.querySelector<HTMLButtonElement>('#task-center-close');
  taskCenterClose?.addEventListener('pointerdown', (event) => { event.preventDefault(); event.stopPropagation(); taskPanelOpen = false; updateTaskCenter(); });
  taskCenterClose?.addEventListener('click', (event) => { if (event.detail !== 0) return; taskPanelOpen = false; updateTaskCenter(); });
  document.querySelectorAll<HTMLButtonElement>('[data-show-copy-queue]').forEach((button) => button.onclick = () => { taskPanelOpen = false; activeView = 'copy'; copySection = 'tasks'; render(); });
  document.querySelectorAll<HTMLButtonElement>('[data-pause-background]').forEach((button) => button.onclick = () => void runTaskAction(button, async () => { backgroundTasks = await window.materialGater.pauseBackgroundTask(button.dataset.pauseBackground!); updateTaskCenter(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-resume-background]').forEach((button) => button.onclick = () => void runTaskAction(button, async () => { backgroundTasks = await window.materialGater.resumeBackgroundTask(button.dataset.resumeBackground!); updateTaskCenter(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-pause-copy]').forEach((button) => button.onclick = () => void runTaskAction(button, async () => { state = await window.materialGater.pauseCopyTask(button.dataset.pauseCopy!); updateTaskCenter(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-resume-copy]').forEach((button) => button.onclick = () => void runTaskAction(button, async () => { state = await window.materialGater.resumeCopyTask(button.dataset.resumeCopy!); updateTaskCenter(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-dismiss-background]').forEach((button) => button.onclick = (event) => { event.stopPropagation(); void runTaskAction(button, async () => { const accepted = await window.materialGater.confirmAction({ title: '清理后台任务记录？', message: `将从列表中移除“${button.dataset.taskTitle || '后台任务'}”。此操作不会删除任何素材。`, okLabel: '清理记录' }); if (!accepted) return; backgroundTasks = await window.materialGater.dismissBackgroundTask(button.dataset.dismissBackground!); updateTaskCenter(); }); });
  document.querySelectorAll<HTMLButtonElement>('[data-dismiss-copy]').forEach((button) => button.onclick = (event) => { event.stopPropagation(); void runTaskAction(button, async () => { const accepted = await window.materialGater.confirmAction({ title: '清理拷贝任务记录？', message: `将从队列中移除“${button.dataset.taskTitle || '拷贝任务'}”。已复制素材和断点文件都会保留。`, okLabel: '清理记录' }); if (!accepted) return; state = await window.materialGater.dismissCopyTask(button.dataset.dismissCopy!); updateTaskCenter(); }); });
  document.querySelector<HTMLButtonElement>('#clear-finished-all')?.addEventListener('click', (event) => { const button = event.currentTarget as HTMLButtonElement; void runTaskAction(button, async () => { const accepted = await window.materialGater.confirmAction({ title: '清理全部已结束任务？', message: '将移除已完成、失败和已取消的任务记录。素材、已复制文件与断点文件都不会被删除。', okLabel: '全部清理' }); if (!accepted) return; [backgroundTasks, state] = await Promise.all([window.materialGater.clearFinishedBackgroundTasks(), window.materialGater.clearFinishedCopyTasks()]); updateTaskCenter(); }); });
}

function updateTaskCenter() { const host = document.querySelector<HTMLElement>('.task-center-host'); if (!host) return; host.innerHTML = taskCenterMarkup(); bindTaskCenter(); }

async function runTaskAction(button: HTMLButtonElement, action: () => Promise<void>) {
  button.disabled = true;
  try { await action(); }
  catch (error) { showToast(String(error), 'error'); }
  finally { if (button.isConnected) button.disabled = false; }
}

const preservedScrollSelectors = ['.detail-pane', '.list-pane', '.single-pane', '.copy-selection-workspace', '.copy-files', '.copy-picker-content', '.task-center-list', '.repository-form', '.settings-primary'];
type ScrollSnapshot = Array<{ selector: string; index: number; top: number; left: number }>;
function captureScroll(scope: ParentNode = document): ScrollSnapshot { return preservedScrollSelectors.flatMap((selector) => [...scope.querySelectorAll<HTMLElement>(selector)].map((element, index) => ({ selector, index, top: element.scrollTop, left: element.scrollLeft }))); }
function restoreScroll(snapshot: ScrollSnapshot, scope: ParentNode = document) { for (const item of snapshot) { const element = scope.querySelectorAll<HTMLElement>(item.selector)[item.index]; if (element) { element.scrollTop = item.top; element.scrollLeft = item.left; } } }
function render() { const scroll = captureScroll(); const heading = viewTitle(); root.innerHTML = `<div class="app-shell"><aside class="sidebar"><div class="brand"><strong>Material Gater</strong><div class="task-center-host">${taskCenterMarkup()}</div></div><nav><button data-view="mappings" class="${activeView === 'mappings' ? 'active' : ''}">${svg('map')}映射<span>${state.catalog.mappings.length || ''}</span></button><button data-view="copy" class="${activeView === 'copy' ? 'active' : ''}">${svg('copy')}拷贝<span>${state.catalog.tasks.length || ''}</span></button><button data-view="repositories" class="${activeView === 'repositories' ? 'active' : ''}">${svg('storage')}储存位置<span>${state.catalog.repositories.length}</span></button><button data-view="activity" class="${activeView === 'activity' ? 'active' : ''}">${svg('chart')}统计</button></nav><div class="sidebar-heading"><span>素材源</span><button id="choose-source">${svg('plus')}</button></div><div class="source-list">${sourceRows()}</div><div class="sidebar-bottom">${driveMonitor()}<nav class="bottom-nav"><button data-view="settings" class="${activeView === 'settings' ? 'active' : ''}">${svg('settings')}设置</button></nav></div></aside><main class="workspace"><header class="toolbar"><div class="toolbar-heading"><h1>${escapeHtml(heading.title)}</h1>${heading.subtitle ? `<span>${escapeHtml(heading.subtitle)}</span>` : ''}</div><div class="toolbar-actions">${filterControls()}</div></header><div class="view-transition">${mainContent()}</div></main></div>${sourceContextMenu()}${activeView === 'copy' && copySection === 'create' && copyStep === 1 && copyPickerOpen ? copyPickerOverlay() : ''}`; bindEvents(); restoreScroll(scroll); }

function readMapping(): MappingInput { const sourceUuid = document.querySelector<HTMLSelectElement>('#mapping-source')?.value || ''; const drive = drives.find((item) => item.uuid === sourceUuid); const current = currentMapping(); const mode = document.querySelector<HTMLInputElement>('input[name="mapping-mode"]:checked')?.value === 'original' ? 'original' : 'flat'; return { id: current?.id, name: document.querySelector<HTMLInputElement>('#mapping-name')?.value || '', sourceUuid, source: drive?.path || current?.source || '', destination: document.querySelector<HTMLInputElement>('#mapping-destination')?.value || '', extensions: [...document.querySelectorAll<HTMLInputElement>('.extensions input:checked')].map((item) => item.value), startDate: document.querySelector<HTMLInputElement>('#mapping-start')?.value || '', endDate: document.querySelector<HTMLInputElement>('#mapping-end')?.value || '', mode, groupByDay: mode === 'flat' && Boolean(document.querySelector<HTMLInputElement>('#mapping-group-day')?.checked) }; }
function readRepository() {
  const current = repositoryDraft || state.catalog.repositories.find((item) => item.id === selectedRepositoryId);
  return {
    id: current?.id, name: document.querySelector<HTMLInputElement>('#repo-name')?.value || '', type: current?.type || 'local',
    root: document.querySelector<HTMLInputElement>('#repo-root')?.value || '', address: document.querySelector<HTMLInputElement>('#repo-address')?.value || '',
    remotePath: document.querySelector<HTMLInputElement>('#repo-remote-path')?.value || '', username: document.querySelector<HTMLInputElement>('#repo-username')?.value || '',
    domain: document.querySelector<HTMLInputElement>('#repo-domain')?.value || '', port: Number(document.querySelector<HTMLInputElement>('#repo-port')?.value || 0),
    password: document.querySelector<HTMLInputElement>('#repo-password')?.value || '', isDefault: document.querySelector<HTMLInputElement>('#repo-default')?.checked || false,
    defaultPathTemplate: document.querySelector<HTMLInputElement>('#repo-default-template')?.value || '%day/%note',
    defaultMode: (document.querySelector<HTMLInputElement>('input[name="repo-default-mode"]:checked')?.value || 'flat') as 'flat' | 'original'
  };
}

function bindMediaInteractions(scope: ParentNode = document) { scope.querySelectorAll<HTMLElement>('[data-file-path]').forEach((row) => { row.onclick = (event) => { if ((event.target as HTMLElement).closest('button,input')) return; const copyInput = row.querySelector<HTMLInputElement>('.copy-file-check'); if (!copyInput) return; copyInput.checked = !copyInput.checked; const file = ensureCopyFileIndex().get(copyInput.dataset.copyId!); if (file) setCopyFileSelected(file, copyInput.checked); updateCopySelectionUI(copyInput); }; row.onkeydown = (event) => { if (event.code !== 'Space') return; event.preventDefault(); const copyInput = row.querySelector<HTMLInputElement>('.copy-file-check'); if (!copyInput) return; copyInput.checked = !copyInput.checked; const file = ensureCopyFileIndex().get(copyInput.dataset.copyId!); if (file) setCopyFileSelected(file, copyInput.checked); updateCopySelectionUI(copyInput); }; }); scope.querySelectorAll<HTMLButtonElement>('[data-preview-path]').forEach((button) => button.onclick = (event) => { event.stopPropagation(); void window.materialGater.previewMedia(button.dataset.previewPath!); }); }
function bindEvents() {
  bindTaskCenter();
  document.querySelector<HTMLElement>('.app-shell')?.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement;
    let rerender = false;
    if (sourceMenuUuid && !target.closest('.source-context-menu')) { sourceMenuUuid = ''; rerender = true; }
    if (rerender) render();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => button.onclick = () => { activeView = button.dataset.view as View; render(); });
  document.querySelectorAll<HTMLButtonElement>('[data-source-uuid]').forEach((button) => { button.onclick = () => { selectedSourceUuid = button.dataset.sourceUuid!; activeView = 'source'; rawPath = ''; rawEntries = []; void loadRaw(''); }; button.oncontextmenu = (event) => { event.preventDefault(); sourceMenuUuid = button.dataset.sourceUuid!; sourceMenuX = Math.min(event.clientX, window.innerWidth - 250); sourceMenuY = Math.min(event.clientY, window.innerHeight - 300); render(); }; button.onpointerenter = async () => { const uuid = button.dataset.sourceUuid!; if (driveHealth.has(uuid)) return; try { const health = await window.materialGater.getDriveHealth(uuid); driveHealth.set(uuid, health); const popover = document.querySelector<HTMLElement>(`[data-health-uuid="${CSS.escape(uuid)}"]`); if (popover) popover.innerHTML = driveHealthMarkup(health); } catch { /* Offline drives leave the availability message visible. */ } }; });
  document.querySelectorAll<HTMLButtonElement>('[data-source-action]').forEach((button) => button.onclick = async (event) => { event.stopPropagation(); const uuid = sourceMenuUuid; const drive = drives.find((item) => item.uuid === uuid); if (!drive) return; const action = button.dataset.sourceAction; sourceMenuUuid = ''; try { if (action === 'reload') { drives = await window.materialGater.refreshDrives(); if (selectedSourceUuid === uuid && activeView === 'source') await loadRaw(rawPath); else render(); showToast('磁盘状态已重载'); } else if (action === 'rescan') { await window.materialGater.scan(drive.path); showToast('重新扫描任务已加入后台'); render(); } else if (action === 'cancel') { backgroundTasks = await window.materialGater.cancelSourceIndex(uuid); showToast('扫描任务已取消'); render(); } else if (action === 'repository') { const repositoryOnly = !sourceRecord(uuid)?.repositoryOnly; state = await window.materialGater.setSourceRepository(uuid, repositoryOnly); clearCopySelection(); showToast(repositoryOnly ? '已标记为储存盘，不再扫描' : '已取消储存盘标记'); render(); } else if (action === 'eject') { const accepted = await window.materialGater.confirmAction({ title: `卸载“${drive.name}”？`, message: '请先确认没有拷贝或校验任务正在使用此磁盘。卸载不会删除磁盘中的文件。', okLabel: '安全卸载', kind: 'warning' }); if (!accepted) { render(); return; } await window.materialGater.ejectDrive(uuid); showToast('已请求系统安全卸载磁盘'); render(); } } catch (error) { showToast(String(error), 'error'); render(); } });
  document.querySelector<HTMLButtonElement>('#choose-source')?.addEventListener('click', async () => { const path = await window.materialGater.chooseDirectory('选择素材目录'); if (path) { await window.materialGater.scan(path); showToast('文件扫描任务已加入后台'); } });
  document.querySelector<HTMLSelectElement>('#filter-extension')?.addEventListener('change', (event) => { filterExtension = (event.target as HTMLSelectElement).value; render(); });
  document.querySelector<HTMLInputElement>('#filter-start')?.addEventListener('change', (event) => { filterStart = (event.target as HTMLInputElement).value; render(); });
  document.querySelector<HTMLInputElement>('#filter-end')?.addEventListener('change', (event) => { filterEnd = (event.target as HTMLInputElement).value; render(); });
  document.querySelector<HTMLButtonElement>('#export-statistics')?.addEventListener('click', async () => { try { const destination = await window.materialGater.chooseStatisticsExport(); if (!destination) return; const exported = await window.materialGater.exportStatistics({ destination, extension: filterExtension, startDate: filterStart, endDate: filterEnd }); showToast(`统计数据已导出到 ${exported}`); } catch (error) { showToast(String(error), 'error'); } });
  bindMediaInteractions();
  document.querySelectorAll<HTMLButtonElement>('[data-mapping]').forEach((button) => button.onclick = () => { selectedMappingId = button.dataset.mapping!; editorBuffer = null; render(); });
  const newMapping = () => { editorBuffer = blankMapping(); selectedMappingId = ''; activeView = 'mappings'; render(); };
  document.querySelector<HTMLButtonElement>('#new-mapping')?.addEventListener('click', newMapping); document.querySelector<HTMLButtonElement>('#toolbar-new-mapping')?.addEventListener('click', newMapping);
  document.querySelector<HTMLButtonElement>('#pick-destination')?.addEventListener('click', async () => { editorBuffer = readMapping(); const value = await window.materialGater.chooseDirectory('选择链接输出目录'); if (value) editorBuffer.destination = value; render(); });
  document.querySelector<HTMLSelectElement>('#mapping-source')?.addEventListener('change', () => { editorBuffer = readMapping(); render(); });
  document.querySelectorAll<HTMLInputElement>('input[name="mapping-mode"]').forEach((input) => input.onchange = () => { editorBuffer = readMapping(); render(); });
  const saveMapping = async (run = false) => {
    if (busyAction) return;
    const input = readMapping();
    const saveButton = document.querySelector<HTMLButtonElement>('#save-mapping');
    const runButton = document.querySelector<HTMLButtonElement>('#run-mapping');
    busyAction = run ? 'mapping-mount' : 'mapping-save';
    if (saveButton) saveButton.disabled = true;
    if (runButton) {
      runButton.disabled = true;
      if (run) runButton.textContent = '正在挂载…';
    }
    document.querySelector<HTMLElement>('.mapping-editor')?.setAttribute('aria-busy', 'true');
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      const response = await window.materialGater.saveMapping(input);
      state = response.state;
      selectedMappingId = response.mapping.id;
      editorBuffer = null;
      if (run) {
        const result = await window.materialGater.runMapping(selectedMappingId);
        state = result.state;
        showToast(`已挂载 ${result.result.linked} 个链接`);
      } else {
        showToast('映射已保存');
      }
    } catch (error) {
      showToast(String(error), 'error');
    } finally {
      busyAction = '';
      render();
    }
  };
  document.querySelector<HTMLButtonElement>('#save-mapping')?.addEventListener('click', () => void saveMapping()); document.querySelector<HTMLButtonElement>('#run-mapping')?.addEventListener('click', () => void saveMapping(true));
  document.querySelector<HTMLInputElement>('#mapping-enabled')?.addEventListener('change', async (event) => {
    const toggle = event.currentTarget as HTMLInputElement;
    const enabled = toggle.checked;
    const mapping = state.catalog.mappings.find((item) => item.id === selectedMappingId);
    if (!mapping || busyAction) return;
    busyAction = 'mapping-toggle';
    toggle.disabled = true;
    try {
      const response = await window.materialGater.setMappingEnabled(mapping.id, enabled);
      state = response.state;
      if (enabled) {
        const result = await window.materialGater.runMapping(mapping.id);
        state = result.state;
        showToast(`已挂载 ${result.result.linked} 个链接`);
      } else {
        showToast(response.cleanup?.message || '映射已关闭，链接已清理');
      }
    } catch (error) {
      showToast(String(error), 'error');
    } finally {
      busyAction = '';
      render();
    }
  });
  document.querySelector<HTMLButtonElement>('#delete-mapping')?.addEventListener('click', () => { deleteConfirmOpen = true; render(); }); document.querySelector<HTMLButtonElement>('#cancel-delete')?.addEventListener('click', () => { deleteConfirmOpen = false; render(); });
  const deleteMapping = async (cleanup: boolean) => { const response = await window.materialGater.deleteMapping({ id: selectedMappingId, cleanup }); state = response.state; selectedMappingId = ''; deleteConfirmOpen = false; render(); showToast(response.cleanup?.message || '映射已删除'); };
  document.querySelector<HTMLButtonElement>('#delete-config-only')?.addEventListener('click', () => void deleteMapping(false)); document.querySelector<HTMLButtonElement>('#delete-with-links')?.addEventListener('click', async () => { const accepted = await window.materialGater.confirmAction({ title: '同时移除映射链接？', message: '只会移除由此映射创建的链接；素材源文件不会被删除。', okLabel: '移除链接', kind: 'warning' }); if (accepted) await deleteMapping(true); });
  document.querySelector<HTMLButtonElement>('#raw-back')?.addEventListener('click', () => void loadRaw(rawPath.split(/[\\/]/).slice(0, -1).join('/'))); document.querySelector<HTMLButtonElement>('#raw-scan')?.addEventListener('click', async () => { const drive = currentDrive(); if (drive) { await window.materialGater.scan(drive.path); showToast('文件扫描任务已加入后台'); } });
  document.querySelectorAll<HTMLElement>('[data-raw-path]').forEach((row) => { row.ondblclick = () => row.dataset.directory === 'true' ? void loadRaw(row.dataset.rawRelative!) : void window.materialGater.openMedia(row.dataset.rawPath!); row.oncontextmenu = (event) => { event.preventDefault(); void window.materialGater.showMediaMenu(row.dataset.rawPath!); }; });
  bindCopyEvents(); bindRepositoryEvents(); bindSettingsEvents();
}

function applyCopyPreset(id: string) {
  const preset = [...builtInPresets, ...customPresetDefinitions()].find((item) => item.id === id); if (!preset) return;
  const now = new Date(); const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  activePresetId = id; copyExtensions = [...preset.extensions];
  copyStart = preset.dateMode === 'today' ? today : preset.dateMode === 'all' ? '' : preset.startDate || '';
  copyEnd = preset.dateMode === 'today' ? today : preset.dateMode === 'all' ? '' : preset.endDate || '';
  copyDestinationMode = preset.destinationMode === 'default' ? 'default' : 'custom'; copyRepositoryId = preset.repositoryId || defaultRepository()?.id || ''; copyCustomDestination = '';
  copyTemplate = preset.pathTemplate || ''; copyNote = preset.note || ''; copyMode = preset.mode || 'flat';
  replaceCopySelection(copyCandidateData().files); render();
}

function updateCopySelectionUI(changedInput?: HTMLInputElement) {
  const selectedCount = copySelected.size;
  document.querySelectorAll<HTMLElement>('[data-copy-selected-count], #copy-selected-count').forEach((count) => { count.textContent = `已选 ${selectedCount} 个文件`; });
  document.querySelectorAll<HTMLElement>('[data-copy-selected-size], #copy-selected-size').forEach((sizeLabel) => { sizeLabel.textContent = formatBytes(copySelectedBytes); });
  document.querySelectorAll<HTMLButtonElement>('[data-copy-next], #copy-next, #copy-picker-done').forEach((next) => { next.disabled = selectedCount === 0; });
  const day = changedInput ? localDay(ensureCopyFileIndex().get(changedInput.dataset.copyId || '')?.capturedAt || new Date().toISOString()) : '';
  const dayInputs = day ? document.querySelectorAll<HTMLInputElement>(`.copy-day-check[data-copy-day="${CSS.escape(day)}"]`) : document.querySelectorAll<HTMLInputElement>('.copy-day-check');
  const candidateData = copyCandidateData();
  for (const input of dayInputs) { const total = candidateData.byDay.get(input.dataset.copyDay || '')?.length || 0; const selected = candidateData.selectedByDay.get(input.dataset.copyDay || '') || 0; input.checked = total > 0 && selected === total; input.indeterminate = selected > 0 && selected < total; }
  if (changedInput) changedInput.closest('.copy-media-card')?.classList.toggle('selected', changedInput.checked);
  else document.querySelectorAll<HTMLElement>('.copy-media-card').forEach((card) => { const input = card.querySelector<HTMLInputElement>('.copy-file-check'); if (input) input.checked = copySelected.has(input.dataset.copyId || ''); card.classList.toggle('selected', Boolean(input?.checked)); });
}

function bindCopyFileInputs(scope: ParentNode = document) { scope.querySelectorAll<HTMLInputElement>('.copy-file-check').forEach((input) => input.onchange = () => { const file = ensureCopyFileIndex().get(input.dataset.copyId!); if (file) setCopyFileSelected(file, input.checked); updateCopySelectionUI(input); }); }

function updateCopyWorkspace() {
  if (copyPickerOpen) { render(); return; }
  const wizard = document.querySelector<HTMLElement>('.copy-wizard');
  if (!wizard) { render(); return; }
  const scroll = captureScroll(wizard);
  wizard.innerHTML = `${copyWizardHeader()}${copySection === 'tasks' ? taskQueue() : copyStep === 1 ? copySelectionStage() : copyStep === 2 ? copyDestinationStage() : copyReviewStage()}`;
  bindCopyEvents();
  bindMediaInteractions(wizard);
  restoreScroll(scroll, wizard);
}

function selectCopySection(section: 'create' | 'tasks') {
  if (copySection === section) return;
  copyPickerOpen = false;
  copySection = section;
  updateCopyWorkspace();
}

function bindCopyEvents() {
  const openPicker = () => { copyPickerOpen = true; render(); };
  document.querySelector<HTMLButtonElement>('#copy-open-picker')?.addEventListener('click', openPicker);
  document.querySelector<HTMLButtonElement>('#copy-open-picker-empty')?.addEventListener('click', openPicker);
  document.querySelector<HTMLButtonElement>('#copy-picker-close')?.addEventListener('click', () => { copyPickerOpen = false; render(); });
  document.querySelector<HTMLButtonElement>('#copy-picker-done')?.addEventListener('click', () => { if (!selectedCopyFiles().length) return; copyPickerOpen = false; render(); });
  document.querySelector<HTMLElement>('[data-copy-picker-backdrop]')?.addEventListener('pointerdown', (event) => { if (event.target === event.currentTarget) { copyPickerOpen = false; render(); } });
  document.querySelector<HTMLElement>('.copy-picker-dialog')?.addEventListener('pointerdown', (event) => event.stopPropagation());
  document.querySelectorAll<HTMLButtonElement>('[data-copy-section]').forEach((button) => {
    const activate = () => selectCopySection(button.dataset.copySection as 'create' | 'tasks');
    button.onpointerdown = (event) => { if (event.button !== 0) return; event.preventDefault(); activate(); };
    button.onclick = activate;
  });
  document.querySelectorAll<HTMLButtonElement>('[data-copy-step]').forEach((button) => button.onclick = () => { copyPickerOpen = false; copyStep = Number(button.dataset.copyStep) as 1 | 2 | 3; render(); });
  document.querySelectorAll<HTMLButtonElement>('[data-copy-source]').forEach((button) => button.onclick = () => { copySourceUuid = button.dataset.copySource!; copySelectionMode = 'grouped'; copyCustomDirectory = ''; clearCopySelection(); activePresetId = ''; render(); });
  document.querySelector<HTMLButtonElement>('#copy-pick-directory')?.addEventListener('click', async () => { const value = await window.materialGater.chooseDirectory('指定素材目录'); if (!value) return; const drive = drives.find((item) => value === item.path || value.startsWith(`${item.path}/`) || value.startsWith(`${item.path}\\`)); copySourceUuid = drive?.uuid || value; copySelectionMode = 'directory'; copyCustomDirectory = value; clearCopySelection(); activePresetId = ''; if (!state.catalog.files.some((file) => file.sourceUuid === copySourceUuid && (file.path === value || file.path.startsWith(`${value}/`) || file.path.startsWith(`${value}\\`)))) { await window.materialGater.scan(value); showToast('正在扫描指定路径中的文件'); } render(); });
  document.querySelectorAll<HTMLInputElement>('[data-copy-ext]').forEach((input) => input.onchange = () => { copyExtensions = [...document.querySelectorAll<HTMLInputElement>('[data-copy-ext]:checked')].map((item) => item.dataset.copyExt!); activePresetId = ''; render(); });
  document.querySelector<HTMLInputElement>('#copy-start')?.addEventListener('change', (event) => { copyStart = (event.target as HTMLInputElement).value; activePresetId = ''; render(); });
  document.querySelector<HTMLInputElement>('#copy-end')?.addEventListener('change', (event) => { copyEnd = (event.target as HTMLInputElement).value; activePresetId = ''; render(); });
  document.querySelector<HTMLButtonElement>('#copy-today')?.addEventListener('click', () => { const now = new Date(); const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; copyStart = today; copyEnd = today; activePresetId = ''; render(); });
  document.querySelectorAll<HTMLButtonElement>('[data-quick-ext]').forEach((button) => button.onclick = () => { copyExtensions = [button.dataset.quickExt!]; activePresetId = ''; render(); });
  document.querySelector<HTMLButtonElement>('#copy-clear-rule')?.addEventListener('click', () => { copyExtensions = []; copyStart = ''; copyEnd = ''; activePresetId = ''; render(); });
  document.querySelectorAll<HTMLButtonElement>('[data-apply-preset]').forEach((button) => button.onclick = () => applyCopyPreset(button.dataset.applyPreset!));
  document.querySelectorAll<HTMLButtonElement>('[data-delete-preset]').forEach((button) => button.onclick = async (event) => { event.stopPropagation(); const preset = state.catalog.presets.find((item) => item.id === button.dataset.deletePreset); const accepted = await window.materialGater.confirmAction({ title: '删除自定义预设？', message: `将删除“${preset?.name || '此预设'}”。这不会删除任何素材或任务。`, okLabel: '删除预设' }); if (!accepted) return; state = await window.materialGater.deletePreset(button.dataset.deletePreset!); if (activePresetId === button.dataset.deletePreset) activePresetId = ''; showToast('自定义预设已删除'); render(); });
  bindCopyFileInputs();
  document.querySelectorAll<HTMLInputElement>('.copy-day-check').forEach((input) => input.onchange = () => { const files = copyCandidateData().byDay.get(input.dataset.copyDay || '') || []; for (const file of files) setCopyFileSelected(file, input.checked); input.closest('.copy-date-section')?.querySelectorAll<HTMLInputElement>('.copy-file-check').forEach((fileInput) => { fileInput.checked = input.checked; }); updateCopySelectionUI(); });
  document.querySelectorAll<HTMLElement>('[data-copy-day-toggle]').forEach((header) => {
    const toggle = (event?: Event) => {
      const target = event?.target as HTMLElement | null;
      if (target?.closest('input,label,button,a')) return;
      const day = header.dataset.copyDayToggle!; collapsedCopyDays.has(day) ? collapsedCopyDays.delete(day) : collapsedCopyDays.add(day); updateCopyWorkspace();
    };
    header.onclick = toggle;
    header.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(event); } };
  });
  document.querySelector<HTMLButtonElement>('#copy-select-visible')?.addEventListener('click', () => { replaceCopySelection(copyCandidateData().files); updateCopySelectionUI(); });
  document.querySelector<HTMLButtonElement>('#copy-clear-selected')?.addEventListener('click', () => { clearCopySelection(); updateCopySelectionUI(); });
  const chooseCustomDestination = async () => { const value = await window.materialGater.chooseDirectory('选择本次拷贝的目标文件夹'); if (!value) return; copyDestinationMode = 'custom'; copyCustomDestination = value; copyTemplate = ''; copyMode = 'flat'; render(); };
  document.querySelectorAll<HTMLButtonElement>('[data-destination-mode]').forEach((button) => button.onclick = async () => { const mode = button.dataset.destinationMode as 'default' | 'custom'; if (mode === 'custom') { await chooseCustomDestination(); return; } copyDestinationMode = 'default'; render(); });
  document.querySelector<HTMLButtonElement>('#copy-pick-destination')?.addEventListener('click', chooseCustomDestination);
  document.querySelector<HTMLInputElement>('#copy-note')?.addEventListener('input', (event) => { copyNote = (event.target as HTMLInputElement).value; });
  document.querySelector<HTMLInputElement>('#copy-template')?.addEventListener('input', (event) => { copyTemplate = (event.target as HTMLInputElement).value; });
  document.querySelector<HTMLInputElement>('#copy-preset-name')?.addEventListener('input', (event) => { copyPresetName = (event.target as HTMLInputElement).value; });
  document.querySelectorAll<HTMLInputElement>('input[name="copy-mode"]').forEach((input) => input.onchange = () => { copyMode = input.value as 'flat' | 'original'; });
  document.querySelector<HTMLButtonElement>('#go-repositories')?.addEventListener('click', () => { activeView = 'repositories'; render(); });
  document.querySelectorAll<HTMLButtonElement>('#copy-next').forEach((button) => button.onclick = () => { if (copyStep === 1 && !selectedCopyFiles().length) return; if (copyStep === 2 && !(copyDestinationMode === 'custom' ? copyCustomDestination : resolvedCopyRepository())) return; copyPickerOpen = false; copyStep = (copyStep + 1) as 2 | 3; render(); });
  document.querySelector<HTMLButtonElement>('#copy-back')?.addEventListener('click', () => { copyStep = (copyStep - 1) as 1 | 2; render(); });
  document.querySelector<HTMLButtonElement>('#save-copy-preset')?.addEventListener('click', async () => {
    const name = (document.querySelector<HTMLInputElement>('#copy-preset-name')?.value || copyPresetName).trim(); if (!name) { showToast('请先输入预设名称', 'error'); return; }
    const now = new Date(); const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    state = await window.materialGater.savePreset({ name, extensions: copyExtensions, startDate: copyStart, endDate: copyEnd, dateMode: copyStart === today && copyEnd === today ? 'today' : !copyStart && !copyEnd ? 'all' : 'fixed', destinationMode: copyDestinationMode, repositoryId: resolvedCopyRepository()?.id || '', pathTemplate: resolvedCopyTemplate(), note: copyNote, mode: resolvedCopyMode() });
    copyPresetName = ''; showToast('已保存到自定义预设'); render();
  });
  document.querySelector<HTMLButtonElement>('#start-copy')?.addEventListener('click', async () => {
    try {
      const files = selectedCopyFiles(); const repository = resolvedCopyRepository(); if (!files.length) throw new Error('请选择需要拷贝的素材'); if (copyDestinationMode === 'custom' ? !copyCustomDestination : !repository) throw new Error('请选择储存位置');
      const response = await window.materialGater.createCopyTask({ name: copyNote || `拷贝 ${new Date().toLocaleDateString('zh-CN')}`, sourceUuid: copySourceUuid, repositoryId: repository?.id || '', destinationRoot: copyDestinationMode === 'custom' ? copyCustomDestination : '', selection: { fileIds: files.map((file) => file.id) }, pathTemplate: resolvedCopyTemplate(), note: copyNote, mode: resolvedCopyMode() });
      state = response.state; copySection = 'tasks'; copyStep = 1; copyPickerOpen = false; clearCopySelection(); showToast('拷贝任务已开始'); render();
    } catch (error) { showToast(String(error), 'error'); }
  });
  document.querySelectorAll<HTMLButtonElement>('[data-pause-task]').forEach((button) => button.onclick = () => void runTaskAction(button, async () => { state = await window.materialGater.pauseCopyTask(button.dataset.pauseTask!); render(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-resume-task]').forEach((button) => button.onclick = () => void runTaskAction(button, async () => { state = await window.materialGater.resumeCopyTask(button.dataset.resumeTask!); render(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-dismiss-copy-task]').forEach((button) => button.onclick = () => void runTaskAction(button, async () => { const task = state.catalog.tasks.find((item) => item.id === button.dataset.dismissCopyTask); const accepted = await window.materialGater.confirmAction({ title: '清理拷贝任务记录？', message: `将从队列中移除“${task?.name || '此任务'}”。已复制素材和断点文件都会保留。`, okLabel: '清理记录' }); if (!accepted) return; state = await window.materialGater.dismissCopyTask(button.dataset.dismissCopyTask!); showToast('任务记录已清理'); render(); }));
  document.querySelector<HTMLButtonElement>('#clear-copy-finished')?.addEventListener('click', (event) => { const button = event.currentTarget as HTMLButtonElement; void runTaskAction(button, async () => { const accepted = await window.materialGater.confirmAction({ title: '清理全部已结束任务？', message: '将移除已完成和失败的拷贝任务记录。素材、已复制文件与断点文件都不会被删除。', okLabel: '全部清理' }); if (!accepted) return; state = await window.materialGater.clearFinishedCopyTasks(); showToast('已结束的任务记录已清理'); render(); }); });
}

function bindRepositoryEvents() {
  document.querySelectorAll<HTMLButtonElement>('[data-repository]').forEach((button) => button.onclick = () => { selectedRepositoryId = button.dataset.repository!; repositoryDraft = null; render(); });
  const create = () => { repositoryDraft = { name: '', type: 'local', root: '', address: '', remotePath: '', username: '', domain: '', port: null, isDefault: !state.catalog.repositories.length, defaultPathTemplate: '%day/%note', defaultMode: 'flat' }; selectedRepositoryId = ''; render(); };
  document.querySelector<HTMLButtonElement>('#new-repository')?.addEventListener('click', create); document.querySelector<HTMLButtonElement>('#empty-repository')?.addEventListener('click', create);
  document.querySelectorAll<HTMLButtonElement>('[data-repo-type]').forEach((button) => button.onclick = () => { repositoryDraft = { ...readRepository(), type: button.dataset.repoType as RepositoryType }; render(); });
  document.querySelector<HTMLButtonElement>('#pick-repo-root')?.addEventListener('click', async () => { repositoryDraft = readRepository(); const value = await window.materialGater.chooseDirectory('选择储存库目录'); if (value) repositoryDraft.root = value; render(); });
  document.querySelector<HTMLButtonElement>('#save-repository')?.addEventListener('click', async () => { try { const values = readRepository(); state = await window.materialGater.saveRepository(values); repositoryDraft = null; selectedRepositoryId = values.id || state.catalog.repositories.find((item) => item.name === values.name)?.id || ''; if (!copyRepositoryId) copyRepositoryId = selectedRepositoryId; showToast('储存位置已保存'); render(); } catch (error) { showToast(String(error), 'error'); } });
  document.querySelector<HTMLButtonElement>('#test-repository')?.addEventListener('click', async () => { try { const result = await window.materialGater.testRepository(readRepository()); showToast(result.message); } catch (error) { showToast(String(error), 'error'); } });
  document.querySelector<HTMLButtonElement>('#delete-repository')?.addEventListener('click', async () => { try { const repository = state.catalog.repositories.find((item) => item.id === selectedRepositoryId); const accepted = await window.materialGater.confirmAction({ title: '删除储存位置配置？', message: `将删除“${repository?.name || '此位置'}”的连接配置。目录中的素材和已复制文件不会被删除；仍被任务使用时系统会阻止删除。`, okLabel: '删除配置' }); if (!accepted) return; state = await window.materialGater.deleteRepository(selectedRepositoryId); selectedRepositoryId = ''; showToast('储存位置配置已删除'); render(); } catch (error) { showToast(String(error), 'error'); } });
}

function bindSettingsEvents() {
  document.querySelector<HTMLButtonElement>('#save-settings')?.addEventListener('click', async () => {
    state = await window.materialGater.saveSettings({
      foregroundScanMs: Number(document.querySelector<HTMLSelectElement>('#foreground-frequency')?.value),
      backgroundScanMs: Number(document.querySelector<HTMLSelectElement>('#background-frequency')?.value),
      askBeforeScan: document.querySelector<HTMLInputElement>('#ask-scan')?.checked,
      notifications: document.querySelector<HTMLInputElement>('#notifications')?.checked,
      keepRunning: document.querySelector<HTMLInputElement>('#keep-running')?.checked,
      preventSleepCopy: document.querySelector<HTMLInputElement>('#prevent-sleep-copy')?.checked,
      preventSleepScan: document.querySelector<HTMLInputElement>('#prevent-sleep-scan')?.checked,
      preventSleepMapping: document.querySelector<HTMLInputElement>('#prevent-sleep-mapping')?.checked,
      preventSleepApp: document.querySelector<HTMLInputElement>('#prevent-sleep-app')?.checked
    });
    showToast('设置已保存');
    render();
  });
  document.querySelector<HTMLButtonElement>('#open-data')?.addEventListener('click', () => void window.materialGater.openPath(state.dataDirectory));
}

async function init() {
  [state, drives, backgroundTasks] = await Promise.all([window.materialGater.getState(), window.materialGater.getDrives(), window.materialGater.getBackgroundTasks()]); backgroundTasks = backgroundTasks.filter((task) => task.kind !== 'thumbnail'); selectedSourceUuid = drives[0]?.uuid || ''; copySourceUuid = selectedSourceUuid; selectedMappingId = state.catalog.mappings[0]?.id || ''; selectedRepositoryId = state.catalog.repositories[0]?.id || ''; copyRepositoryId = defaultRepository()?.id || selectedRepositoryId;
  state.catalog.tasks.forEach((task) => knownCopyStatuses.set(task.id, task.status));
  backgroundTasks.forEach((task) => knownBackgroundStatuses.set(task.id, task.status));
  window.materialGater.onDrivesChanged((next) => { const speeds = new Map(drives.map((drive) => [drive.id, drive])); drives = next.map((drive) => ({ ...drive, readBps: speeds.get(drive.id)?.readBps || 0, writeBps: speeds.get(drive.id)?.writeBps || 0 })); if (!selectedSourceUuid && drives[0]) selectedSourceUuid = drives[0].uuid; if (!copySourceUuid && drives[0]) copySourceUuid = drives[0].uuid; render(); });
  window.materialGater.onDriveIo((updates) => { const map = new Map(updates.map((item) => [item.id, item])); drives = drives.map((drive) => ({ ...drive, ...map.get(drive.id) })); updateDriveSpeeds(); });
  window.materialGater.onStateChanged((next) => { state = next; copyCandidateCache = null; render(); }); window.materialGater.onCopyChanged((tasks) => { for (const task of tasks) { const previous = knownCopyStatuses.get(task.id); if (previous && previous !== 'completed' && task.status === 'completed') showToast(`拷贝任务“${task.name}”已完成`); else if (previous && previous !== 'failed' && task.status === 'failed') showToast(`拷贝任务“${task.name}”失败`, 'error'); knownCopyStatuses.set(task.id, task.status); } state.catalog.tasks = tasks; if (activeView === 'copy' && copySection === 'tasks') updateCopyWorkspace(); else updateTaskCenter(); });
  window.materialGater.onBackgroundTasksChanged((tasks) => { const visibleTasks = tasks.filter((task) => task.kind !== 'thumbnail'); for (const task of visibleTasks) { const previous = knownBackgroundStatuses.get(task.id); if (!previous && task.kind === 'scan' && task.status === 'running') showToast(`素材扫描已开始：${task.title}`); else if (previous && previous !== 'failed' && task.status === 'failed') showToast(`${task.title}失败`, 'error'); knownBackgroundStatuses.set(task.id, task.status); } backgroundTasks = visibleTasks; updateTaskCenter(); updateSourceStatuses(); });
  window.materialGater.onSourceRemoved((info) => showToast(`${info.name} 已移除，${info.removedLinks} 个链接已卸载`, 'error')); window.materialGater.onScanCompleted((info) => showToast(`${info.name} 已扫描 ${info.count} 个文件`)); render();
  window.addEventListener('contextmenu', (event) => event.preventDefault(), { capture: true });
  window.addEventListener('blur', () => { if (taskPanelOpen) { taskPanelOpen = false; updateTaskCenter(); } });
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && copyPickerOpen) { copyPickerOpen = false; render(); } });
  document.addEventListener('pointerdown', (event) => {
    if (!taskPanelOpen) return;
    const target = event.target as Element | null;
    if (target?.closest('.task-center-host')) return;
    taskPanelOpen = false;
    updateTaskCenter();
  }, { capture: true });
}

init().catch((error) => { root.innerHTML = `<div class="fatal">启动失败：${escapeHtml(String(error))}</div>`; });
