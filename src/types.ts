export type MediaFile = {
  id: string; name: string; path: string; relativePath: string; extension: string;
  size: number; capturedAt: string; modifiedAt: string; source: string;
};

export type Drive = { id: string; name: string; path: string; kind: string; size?: number; free?: number };
export type StatsGroup = Record<string, { count: number; size: number }>;
export type AppState = {
  catalog: { version: number; files: MediaFile[]; lastScan: string | null; source: string | null };
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
      clearCatalog(): Promise<AppState>;
      openPath(target: string): Promise<string>;
      onDrivesChanged(callback: (drives: Drive[]) => void): () => void;
    };
  }
}

export {};
