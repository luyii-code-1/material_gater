export type MediaFile = {
  id: string; name: string; path: string; relativePath: string; extension: string;
  size: number; capturedAt: string; modifiedAt: string; source: string; sourceUuid?: string;
};

export type DirectoryEntry = { name: string; path: string; relativePath: string; directory: boolean; extension: string; size: number; modifiedAt: string };
export type Drive = { id: string; uuid: string; name: string; path: string; device?: string; kind: string; size?: number; free?: number; readBps?: number; writeBps?: number; active?: boolean };
export type SourceRecord = { uuid: string; name: string; lastPath: string; lastSeen: string; online: boolean; external?: boolean; repositoryOnly?: boolean };
export type DriveHealth = { uuid: string; smartStatus: string; temperatureC: number | null; bytesRead: number | null; bytesWritten: number | null; powerOnHours: number | null; protocol: string; message: string };
export type StatsGroup = Record<string, { count: number; size: number }>;
export type MappingProfile = {
  id: string; name: string; source: string; sourceUuid?: string; destination: string; extensions: string[];
  startDate: string; endDate: string; createdAt: string; updatedAt: string; mounted?: boolean; mountError?: string;
  mode: 'flat' | 'original'; groupByDay: boolean;
  lastRun: null | { at: string; total: number; linked: number; failed: number };
};
export type MappingInput = Pick<MappingProfile, 'name' | 'source' | 'sourceUuid' | 'destination' | 'extensions' | 'startDate' | 'endDate' | 'mode' | 'groupByDay'> & { id?: string };
export type RepositoryType = 'local' | 'smb' | 'ftp' | 'sftp';
export type Repository = {
  id: string; name: string; type: RepositoryType; root: string; address: string; remotePath: string;
  username: string; domain: string; port: number | null; hasPassword: boolean; isDefault: boolean;
  defaultPathTemplate: string; defaultMode: 'flat' | 'original';
};
export type CopyPreset = {
  id: string; name: string; extensions: string[]; startDate: string; endDate: string;
  dateMode?: 'fixed' | 'today' | 'all'; repositoryId: string; destinationMode?: 'default' | 'custom';
  pathTemplate: string; note: string; mode: 'flat' | 'original'; updatedAt: string;
};
export type CopyFileState = { id: string; source: string; relative: string; size: number; copied: number; status: string; error: string; sourceHash: string; verifyStatus: string; verifyError: string };
export type CopyTask = { id: string; name: string; repositoryId: string; sourceUuid: string; status: 'queued' | 'running' | 'verifying' | 'paused' | 'completed' | 'failed'; totalBytes: number; copiedBytes: number; speed: number; eta: number | null; history: number[]; verifyStatus: string; verifiedBytes: number; verifySpeed: number; verifyEta: number | null; verifyHistory: number[]; verifyError: string; files: CopyFileState[]; error?: string; createdAt: string; updatedAt: string };
export type BackgroundTask = { id: string; kind: 'scan' | 'index' | 'thumbnail' | string; title: string; detail: string; status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'; current: number; total: number | null; error: string; startedAt: string; updatedAt: string };
export type ThumbnailResult = { source: string; cachePath: string; ready: boolean };
export type Settings = { foregroundScanMs: number; backgroundScanMs: number; askBeforeScan: boolean; notifications: boolean; keepRunning: boolean };
export type AppState = {
  catalog: { version: number; files: MediaFile[]; sources: SourceRecord[]; mappings: MappingProfile[]; repositories: Repository[]; presets: CopyPreset[]; tasks: CopyTask[]; settings: Settings; lastScan: string | null; source: string | null };
  stats: { count: number; size: number; byDay: StatsGroup; byType: StatsGroup };
  dataDirectory: string; platform: string;
};

export type CopyRequest = { name: string; sourceUuid: string; repositoryId: string; selection: { fileIds?: string[]; extensions?: string[]; startDate?: string; endDate?: string }; pathTemplate: string; note: string; mode: 'flat' | 'original' };

declare global {
  interface Window {
    materialGater: {
      getState(): Promise<AppState>; getDrives(): Promise<Drive[]>; getBackgroundTasks(): Promise<BackgroundTask[]>; chooseDirectory(title: string): Promise<string | null>;
      refreshDrives(): Promise<Drive[]>; getDriveHealth(uuid: string): Promise<DriveHealth>; cancelSourceIndex(uuid: string): Promise<BackgroundTask[]>; setSourceRepository(uuid: string, repositoryOnly: boolean): Promise<AppState>; ejectDrive(uuid: string): Promise<void>;
      chooseStatisticsExport(): Promise<string | null>;
      scan(source: string): Promise<BackgroundTask>; listDirectory(root: string, relative: string): Promise<DirectoryEntry[]>;
      openMedia(target: string): Promise<string>; previewMedia(target: string): Promise<void>; revealMedia(target: string): Promise<void>; showMediaMenu(target: string): Promise<void>;
      requestThumbnails(sources: string[]): Promise<ThumbnailResult[]>; setThumbnailUserActive(active: boolean): Promise<void>; thumbnailUrl(path: string): string;
      createLibrary(options: { destination: string; extensions: string[]; startDate?: string; endDate?: string }): Promise<{ total: number; linked: number; failures: unknown[] }>;
      saveMapping(mapping: MappingInput): Promise<{ state: AppState; mapping: MappingProfile }>;
      runMapping(id: string): Promise<{ state: AppState; result: { total: number; linked: number; failures: unknown[] } }>;
      deleteMapping(request: { id: string; cleanup: boolean }): Promise<{ state: AppState; cleanup: null | { removed: number; kept: boolean; message: string } }>;
      saveRepository(repository: Partial<Repository> & { name: string; type: RepositoryType; password?: string }): Promise<AppState>;
      testRepository(repository: Partial<Repository> & { name: string; type: RepositoryType; password?: string }): Promise<{ ok: boolean; message: string }>;
      deleteRepository(id: string): Promise<AppState>; savePreset(preset: Partial<CopyPreset>): Promise<AppState>; deletePreset(id: string): Promise<AppState>;
      createCopyTask(input: CopyRequest): Promise<{ state: AppState; task: CopyTask }>;
      pauseCopyTask(id: string): Promise<AppState>; resumeCopyTask(id: string): Promise<AppState>; clearCompletedCopyTasks(): Promise<AppState>;
      pauseBackgroundTask(id: string): Promise<BackgroundTask[]>; resumeBackgroundTask(id: string): Promise<BackgroundTask[]>; clearCompletedBackgroundTasks(): Promise<BackgroundTask[]>;
      exportStatistics(request: { destination: string; sourceUuid?: string; extension?: string; startDate?: string; endDate?: string }): Promise<string>;
      saveSettings(settings: Partial<Settings>): Promise<AppState>;
      clearCatalog(): Promise<AppState>; openPath(target: string): Promise<string>;
      onDrivesChanged(callback: (drives: Drive[]) => void): () => void;
      onDriveIo(callback: (speeds: Array<{ id: string; readBps: number; writeBps: number }>) => void): () => void;
      onStateChanged(callback: (state: AppState) => void): () => void; onCopyChanged(callback: (tasks: CopyTask[]) => void): () => void;
      onBackgroundTasksChanged(callback: (tasks: BackgroundTask[]) => void): () => void;
      onThumbnailReady(callback: (thumbnail: ThumbnailResult) => void): () => void;
      onSourceRemoved(callback: (info: Drive & { removedLinks: number }) => void): () => void;
      onScanCompleted(callback: (info: { uuid: string; name: string; count: number }) => void): () => void;
    };
  }
}

export {};
