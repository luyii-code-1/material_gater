export type MediaFile = {
  id: string; name: string; path: string; relativePath: string; extension: string;
  size: number; capturedAt: string; modifiedAt: string; source: string;
};

export type Drive = { id: string; name: string; path: string; device?: string; kind: string; size?: number; free?: number; readBps?: number; writeBps?: number };
export type StatsGroup = Record<string, { count: number; size: number }>;
export type MappingProfile = {
  id: string; name: string; source: string; destination: string; extensions: string[];
  startDate: string; endDate: string; createdAt: string; updatedAt: string;
  lastRun: null | { at: string; total: number; linked: number; failed: number };
};
export type MappingInput = Pick<MappingProfile, 'name' | 'source' | 'destination' | 'extensions' | 'startDate' | 'endDate'> & { id?: string };
export type AppState = {
  catalog: { version: number; files: MediaFile[]; mappings: MappingProfile[]; lastScan: string | null; source: string | null };
  stats: { count: number; size: number; byDay: StatsGroup; byType: StatsGroup };
  dataDirectory: string;
  platform: string;
};

declare global {
  interface Window {
    materialGater: {
      getState(): Promise<AppState>;
      getDrives(): Promise<Drive[]>;
      chooseDirectory(title: string): Promise<string | null>;
      scan(source: string): Promise<AppState>;
      createLibrary(options: { destination: string; extensions: string[]; startDate?: string; endDate?: string }): Promise<{ total: number; linked: number; failures: unknown[] }>;
      saveMapping(mapping: MappingInput): Promise<{ state: AppState; mapping: MappingProfile }>;
      runMapping(id: string): Promise<{ state: AppState; result: { total: number; linked: number; failures: unknown[] } }>;
      deleteMapping(request: { id: string; cleanup: boolean }): Promise<{ state: AppState; cleanup: null | { removed: number; kept: boolean; message: string } }>;
      clearCatalog(): Promise<AppState>;
      openPath(target: string): Promise<string>;
      onDrivesChanged(callback: (drives: Drive[]) => void): () => void;
      onDriveIo(callback: (speeds: Array<{ id: string; readBps: number; writeBps: number }>) => void): () => void;
    };
  }
}

export {};
