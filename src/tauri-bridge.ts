import { invoke } from '@tauri-apps/api/core';
import { listen, type EventCallback, type UnlistenFn } from '@tauri-apps/api/event';
import { confirm, open } from '@tauri-apps/plugin-dialog';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import type {
  AppState, CopyPreset, CopyRequest, CopyTask, DirectoryEntry, Drive, MappingInput,
  MappingProfile, Repository, RepositoryType, Settings
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
  chooseDirectory: async (title) => {
    const value = await open({ title, directory: true, multiple: false, canCreateDirectories: true });
    return typeof value === 'string' ? value : null;
  },
  scan: (source) => invoke<AppState>('scan_media', { source }),
  listDirectory: (root, relative) => invoke<DirectoryEntry[]>('list_directory', { root, relative }),
  openMedia: async (target) => { await openPath(target); return ''; },
  revealMedia: (target) => revealItemInDir(target),
  showMediaMenu: (target) => invoke<void>('show_media_menu', { target }),
  createLibrary: (options) => invoke('create_library', { options }),
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
  saveSettings: (settings: Partial<Settings>) => invoke<AppState>('save_settings', { values: settings }),
  clearCatalog: () => invoke<AppState>('clear_catalog'),
  openPath: async (target) => { await openPath(target); return ''; },
  onDrivesChanged: (callback) => subscribe('drives-changed', callback),
  onDriveIo: (callback) => subscribe('drives-io', callback),
  onStateChanged: (callback) => subscribe('state-changed', callback),
  onCopyChanged: (callback) => subscribe('copy-changed', callback),
  onSourceRemoved: (callback) => subscribe('source-removed', callback),
  onScanCompleted: (callback) => subscribe('scan-completed', callback)
};

void listen<Drive>('drive-detected', async ({ payload: drive }) => {
  await invoke('show_window');
  const accepted = await confirm(`检测到“${drive.name}”\n\n是否立即扫描并刷新素材库？`, {
    title: '检测到素材盘',
    kind: 'info',
    okLabel: '扫描素材',
    cancelLabel: '稍后'
  });
  if (accepted) await invoke('scan_media', { source: drive.path });
});
