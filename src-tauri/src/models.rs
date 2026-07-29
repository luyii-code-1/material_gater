use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MediaFile {
    pub id: String,
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub extension: String,
    pub size: u64,
    pub captured_at: String,
    pub modified_at: String,
    pub source: String,
    pub source_uuid: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub directory: bool,
    pub extension: String,
    pub size: u64,
    pub modified_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Drive {
    pub id: String,
    pub uuid: String,
    pub name: String,
    pub path: String,
    pub device: String,
    pub kind: String,
    pub size: u64,
    pub free: u64,
    pub read_bps: f64,
    pub write_bps: f64,
    pub active: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SourceRecord {
    pub uuid: String,
    pub name: String,
    pub last_path: String,
    pub last_seen: String,
    pub online: bool,
    pub external: bool,
    pub repository_only: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MappingRun {
    pub at: String,
    pub total: usize,
    pub linked: usize,
    pub failed: usize,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MappingProfile {
    pub id: String,
    pub name: String,
    pub source: String,
    pub source_uuid: String,
    pub destination: String,
    pub extensions: Vec<String>,
    pub start_date: String,
    pub end_date: String,
    pub mode: String,
    pub group_by_day: bool,
    pub created_at: String,
    pub updated_at: String,
    pub mounted: bool,
    pub mount_error: String,
    pub last_run: Option<MappingRun>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MappingInput {
    pub id: Option<String>,
    pub name: String,
    pub source: String,
    pub source_uuid: String,
    pub destination: String,
    pub extensions: Vec<String>,
    pub start_date: String,
    pub end_date: String,
    pub mode: String,
    pub group_by_day: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Repository {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub repository_type: String,
    pub root: String,
    pub address: String,
    pub remote_path: String,
    pub username: String,
    pub domain: String,
    pub port: Option<u16>,
    pub has_password: bool,
    pub is_default: bool,
    pub default_path_template: String,
    pub default_mode: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RepositoryInput {
    pub id: Option<String>,
    pub name: String,
    #[serde(rename = "type")]
    pub repository_type: String,
    pub root: String,
    pub address: String,
    pub remote_path: String,
    pub username: String,
    pub domain: String,
    pub port: Option<u16>,
    pub password: String,
    pub is_default: bool,
    pub default_path_template: String,
    pub default_mode: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CopyPreset {
    pub id: String,
    pub name: String,
    pub extensions: Vec<String>,
    pub start_date: String,
    pub end_date: String,
    pub date_mode: String,
    pub repository_id: String,
    pub destination_mode: String,
    pub path_template: String,
    pub note: String,
    pub mode: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CopyFileState {
    pub id: String,
    pub source: String,
    pub relative: String,
    pub size: u64,
    pub copied: u64,
    pub status: String,
    pub error: String,
    pub source_hash: String,
    pub verify_status: String,
    pub verify_error: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CopyTask {
    pub id: String,
    pub name: String,
    pub repository_id: String,
    pub destination_root: String,
    pub source_uuid: String,
    pub status: String,
    pub total_bytes: u64,
    pub copied_bytes: u64,
    pub speed: f64,
    pub eta: Option<u64>,
    pub history: Vec<f64>,
    pub verify_status: String,
    pub verified_bytes: u64,
    pub verify_speed: f64,
    pub verify_eta: Option<u64>,
    pub verify_history: Vec<f64>,
    pub verify_error: String,
    pub files: Vec<CopyFileState>,
    pub error: String,
    pub path_template: String,
    pub note: String,
    pub mode: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BackgroundTask {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub status: String,
    pub current: u64,
    pub total: Option<u64>,
    pub error: String,
    pub started_at: String,
    pub updated_at: String,
}

fn default_foreground_scan_ms() -> u64 {
    1_000
}
fn default_background_scan_ms() -> u64 {
    3_000
}
fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_foreground_scan_ms")]
    pub foreground_scan_ms: u64,
    #[serde(default = "default_background_scan_ms")]
    pub background_scan_ms: u64,
    #[serde(default = "default_true")]
    pub ask_before_scan: bool,
    #[serde(default = "default_true")]
    pub notifications: bool,
    #[serde(default = "default_true")]
    pub keep_running: bool,
    #[serde(default)]
    pub ffmpeg_path: String,
    #[serde(default)]
    pub prevent_sleep_copy: bool,
    #[serde(default)]
    pub prevent_sleep_scan: bool,
    #[serde(default)]
    pub prevent_sleep_mapping: bool,
    #[serde(default)]
    pub prevent_sleep_app: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SettingsPatch {
    pub foreground_scan_ms: Option<u64>,
    pub background_scan_ms: Option<u64>,
    pub ask_before_scan: Option<bool>,
    pub notifications: Option<bool>,
    pub keep_running: Option<bool>,
    pub ffmpeg_path: Option<String>,
    pub prevent_sleep_copy: Option<bool>,
    pub prevent_sleep_scan: Option<bool>,
    pub prevent_sleep_mapping: Option<bool>,
    pub prevent_sleep_app: Option<bool>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            foreground_scan_ms: 1_000,
            background_scan_ms: 3_000,
            ask_before_scan: true,
            notifications: true,
            keep_running: true,
            ffmpeg_path: String::new(),
            prevent_sleep_copy: false,
            prevent_sleep_scan: false,
            prevent_sleep_mapping: false,
            prevent_sleep_app: false,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegInfo {
    pub path: String,
    pub version: String,
    pub valid: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Catalog {
    pub version: u32,
    pub files: Vec<MediaFile>,
    pub sources: Vec<SourceRecord>,
    pub mappings: Vec<MappingProfile>,
    pub repositories: Vec<Repository>,
    pub presets: Vec<CopyPreset>,
    pub tasks: Vec<CopyTask>,
    pub settings: Settings,
    pub last_scan: Option<String>,
    pub source: Option<String>,
}

impl Default for Catalog {
    fn default() -> Self {
        Self {
            version: 7,
            files: vec![],
            sources: vec![],
            mappings: vec![],
            repositories: vec![],
            presets: vec![],
            tasks: vec![],
            settings: Settings::default(),
            last_scan: None,
            source: None,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StatsBucket {
    pub count: usize,
    pub size: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Stats {
    pub count: usize,
    pub size: u64,
    pub by_day: BTreeMap<String, StatsBucket>,
    pub by_type: BTreeMap<String, StatsBucket>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub catalog: Catalog,
    pub stats: Stats,
    pub data_directory: String,
    pub platform: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CopySelection {
    pub file_ids: Vec<String>,
    pub extensions: Vec<String>,
    pub start_date: String,
    pub end_date: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CopyRequest {
    pub name: String,
    pub source_uuid: String,
    pub repository_id: String,
    pub destination_root: String,
    pub selection: CopySelection,
    pub path_template: String,
    pub note: String,
    pub mode: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LibraryOptions {
    pub id: String,
    pub destination: String,
    pub extensions: Vec<String>,
    pub start_date: String,
    pub end_date: String,
    pub mode: String,
    pub group_by_day: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DriveHealth {
    pub uuid: String,
    pub smart_status: String,
    pub temperature_c: Option<f64>,
    pub bytes_read: Option<u64>,
    pub bytes_written: Option<u64>,
    pub power_on_hours: Option<u64>,
    pub protocol: String,
    pub message: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DeleteMappingRequest {
    pub id: String,
    pub cleanup: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DriveIo {
    pub id: String,
    pub read_bps: f64,
    pub write_bps: f64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ThumbnailResult {
    pub source: String,
    pub cache_path: String,
    pub ready: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StatsExportRequest {
    pub destination: String,
    pub source_uuid: String,
    pub extension: String,
    pub start_date: String,
    pub end_date: String,
}
