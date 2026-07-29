import { invoke } from '@tauri-apps/api/core';
import { listen, type EventCallback, type UnlistenFn } from '@tauri-apps/api/event';
import { confirm, open, save } from '@tauri-apps/plugin-dialog';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import type {
  AppState, BackgroundTask, CopyPreset, CopyRequest, CopyTask, DirectoryEntry, Drive, DriveHealth,
  MappingInput, MappingProfile, Repository, RepositoryType, Settings
} from './types';

function subscribe<T>(event: string, callback: (payload: T) => void): () => void {
  let unlisten: UnlistenFn | undefined;
  const handler: EventCallback<T> = ({ payload }) => callback(payload);
  void listen<T>(event, handler).then((value) => { unlisten = value; });
  return () => { unlisten?.(); };
}

window.materialGater = {
  getState: () => invoke<AppState>('get_state'),
  getDrives: () => invoke<Drive[]>('get_drives'),
  refreshDrives: () => invoke<Drive[]>('refresh_drives'),
  getDriveHealth: (uuid) => invoke<DriveHealth>('get_drive_health', { uuid }),
  cancelSourceIndex: (uuid) => invoke<BackgroundTask[]>('cancel_source_index', { uuid }),
  setSourceRepository: (uuid, repositoryOnly) => invoke<AppState>('set_source_repository', { uuid, repositoryOnly }),
  ejectDrive: (uuid) => invoke<void>('eject_drive', { uuid }),
  getBackgroundTasks: () => invoke<BackgroundTask[]>('get_background_tasks'),
  chooseDirectory: async (title) => {
    const value = await open({ title, directory: true, multiple: false, canCreateDirectories: true });
    return typeof value === 'string' ? value : null;
  },
  confirmAction: ({ title, message, okLabel = '确认', kind = 'warning' }) => confirm(message, {
    title,
    kind,
    okLabel,
    cancelLabel: '取消'
  }),
  chooseStatisticsExport: () => save({
    title: '导出统计数据',
    defaultPath: `Material-Gater-统计-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV 表格', extensions: ['csv'] }, { name: 'JSON 数据', extensions: ['json'] }]
  }),
  scan: (source) => invoke<BackgroundTask>('scan_media', { source }),
  listDirectory: (root, relative) => invoke<DirectoryEntry[]>('list_directory', { root, relative }),
  openMedia: async (target) => { await openPath(target); return ''; },
  previewMedia: (target) => invoke<void>('preview_media', { target }),
  revealMedia: (target) => revealItemInDir(target),
  showMediaMenu: (target) => invoke<void>('show_media_menu', { target }),
  saveMapping: (mapping: MappingInput) => invoke<{ state: AppState; mapping: MappingProfile }>('save_mapping', { input: mapping }),
  runMapping: (id) => invoke('run_mapping', { id }),
  deleteMapping: (request) => invoke('delete_mapping', { request }),
  saveRepository: (repository: Partial<Repository> & { name: string; type: RepositoryType; password?: string }) => invoke<AppState>('save_repository', { input: repository }),
  testRepository: (repository) => invoke('test_repository', { input: repository }),
  deleteRepository: (id) => invoke<AppState>('delete_repository', { id }),
  savePreset: (preset: Partial<CopyPreset>) => invoke<AppState>('save_preset', { input: preset }),
  deletePreset: (id) => invoke<AppState>('delete_preset', { id }),
  createCopyTask: (input: CopyRequest) => invoke<{ state: AppState; task: CopyTask }>('create_copy_task', { input }),
  pauseCopyTask: (id) => invoke<AppState>('pause_copy_task', { id }),
  resumeCopyTask: (id) => invoke<AppState>('resume_copy_task', { id }),
  clearCompletedCopyTasks: () => invoke<AppState>('clear_completed_copy_tasks'),
  clearFinishedCopyTasks: () => invoke<AppState>('clear_finished_copy_tasks'),
  dismissCopyTask: (id) => invoke<AppState>('dismiss_copy_task', { id }),
  pauseBackgroundTask: (id) => invoke<BackgroundTask[]>('pause_background_task', { id }),
  resumeBackgroundTask: (id) => invoke<BackgroundTask[]>('resume_background_task', { id }),
  clearCompletedBackgroundTasks: () => invoke<BackgroundTask[]>('clear_completed_background_tasks'),
  clearFinishedBackgroundTasks: () => invoke<BackgroundTask[]>('clear_finished_background_tasks'),
  dismissBackgroundTask: (id) => invoke<BackgroundTask[]>('dismiss_background_task', { id }),
  exportStatistics: (request) => invoke<string>('export_statistics', { request }),
  saveSettings: (settings: Partial<Settings>) => invoke<AppState>('save_settings', { values: settings }),
  clearCatalog: () => invoke<AppState>('clear_catalog'),
  openPath: async (target) => { await openPath(target); return ''; },
  onDrivesChanged: (callback) => subscribe('drives-changed', callback),
  onDriveIo: (callback) => subscribe('drives-io', callback),
  onStateChanged: (callback) => subscribe('state-changed', callback),
  onCopyChanged: (callback) => subscribe('copy-changed', callback),
  onBackgroundTasksChanged: (callback) => subscribe('background-tasks-changed', callback),
  onSourceRemoved: (callback) => subscribe('source-removed', callback),
  onScanCompleted: (callback) => subscribe('scan-completed', callback)
};

void listen<Drive>('drive-detected', async ({ payload: drive }) => {
  await invoke('show_window');
  const accepted = await confirm(`检测到“${drive.name}”\n\n是否立即扫描此磁盘中的文件？`, {
    title: '检测到素材盘',
    kind: 'info',
    okLabel: '扫描文件',
    cancelLabel: '稍后'
  });
  if (accepted) await invoke('scan_media', { source: drive.path });
});
