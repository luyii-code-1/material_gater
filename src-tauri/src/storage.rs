use crate::models::{AppState, Catalog, Drive, Stats, StatsBucket};
use anyhow::{Context, Result};
use chrono::{DateTime, Local};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;
use tauri::{AppHandle, Manager};

pub const SERVICE_NAME: &str = "com.materialgater.app";

pub struct RuntimeState {
    pub catalog: RwLock<Catalog>,
    pub drives: RwLock<Vec<Drive>>,
    pub data_dir: PathBuf,
    pub pauses: RwLock<HashMap<String, Arc<AtomicBool>>>,
    pub io_counters: RwLock<HashMap<String, (u64, u64)>>,
    pub io_sampled_at: RwLock<Instant>,
    pub context_target: RwLock<Option<PathBuf>>,
    pub source_watchers: Mutex<HashMap<String, notify::RecommendedWatcher>>,
    pub scan_debounces: Mutex<HashMap<String, Instant>>,
}

impl RuntimeState {
    pub fn new(catalog: Catalog, data_dir: PathBuf) -> Self {
        Self {
            catalog: RwLock::new(catalog),
            drives: RwLock::new(vec![]),
            data_dir,
            pauses: RwLock::new(HashMap::new()),
            io_counters: RwLock::new(HashMap::new()),
            io_sampled_at: RwLock::new(Instant::now()),
            context_target: RwLock::new(None),
            source_watchers: Mutex::new(HashMap::new()),
            scan_debounces: Mutex::new(HashMap::new()),
        }
    }
}

pub fn resolve_data_directory(app: &AppHandle) -> Result<PathBuf> {
    let executable = std::env::current_exe().context("无法确定程序位置")?;
    let portable = executable
        .file_stem()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.to_ascii_lowercase().contains("portable"));
    if portable {
        return Ok(executable
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("MaterialGaterData"));
    }
    if cfg!(debug_assertions) {
        return Ok(std::env::current_dir()
            .context("无法确定项目目录")?
            .join("portable-data"));
    }
    Ok(app
        .path()
        .app_data_dir()
        .context("无法确定应用数据目录")?
        .join("data"))
}

fn legacy_data_directory(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        return app
            .path()
            .home_dir()
            .ok()
            .map(|home| home.join("Library/Application Support/material-gater/data"));
    }
    #[cfg(target_os = "windows")]
    {
        return std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|root| root.join("material-gater/data"));
    }
    #[allow(unreachable_code)]
    None
}

pub fn load_catalog(app: &AppHandle, data_dir: &Path) -> Result<Catalog> {
    fs::create_dir_all(data_dir).context("无法创建应用数据目录")?;
    let destination = data_dir.join("catalog.json");
    if !destination.exists()
        && let Some(legacy) = legacy_data_directory(app).map(|path| path.join("catalog.json"))
        && legacy.exists()
    {
        fs::copy(&legacy, &destination)
            .with_context(|| format!("无法迁移旧素材库：{}", legacy.display()))?;
    }
    let mut catalog = match fs::read_to_string(&destination) {
        Ok(text) => serde_json::from_str::<Catalog>(&text).unwrap_or_default(),
        Err(_) => Catalog::default(),
    };
    catalog.version = 5;
    for repository in &mut catalog.repositories {
        if repository.repository_type == "usb" {
            repository.repository_type = "local".into();
        }
        if repository.default_path_template.is_empty() {
            repository.default_path_template = "%day/%note".into();
        }
        if repository.default_mode != "original" {
            repository.default_mode = "flat".into();
        }
    }
    if !catalog.repositories.is_empty()
        && !catalog
            .repositories
            .iter()
            .any(|repository| repository.is_default)
    {
        catalog.repositories[0].is_default = true;
    }
    for task in &mut catalog.tasks {
        if task.status == "running" || task.status == "queued" {
            task.status = "paused".into();
        }
    }
    save_catalog_to(data_dir, &catalog)?;
    Ok(catalog)
}

pub fn save_catalog(state: &RuntimeState) -> Result<()> {
    let catalog = state
        .catalog
        .read()
        .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?
        .clone();
    save_catalog_to(&state.data_dir, &catalog)
}

fn save_catalog_to(data_dir: &Path, catalog: &Catalog) -> Result<()> {
    fs::create_dir_all(data_dir)?;
    let destination = data_dir.join("catalog.json");
    let temporary = data_dir.join("catalog.json.tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(catalog)?).context("无法写入素材库")?;
    if destination.exists() {
        let _ = fs::remove_file(&destination);
    }
    fs::rename(&temporary, &destination).context("无法提交素材库更新")?;
    Ok(())
}

pub fn store_password(id: &str, password: &str) -> Result<()> {
    if password.is_empty() {
        return Ok(());
    }
    keyring::Entry::new(SERVICE_NAME, id)?
        .set_password(password)
        .context("系统安全存储拒绝保存密码")
}

pub fn read_password(id: &str) -> String {
    keyring::Entry::new(SERVICE_NAME, id)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .unwrap_or_default()
}

pub fn delete_password(id: &str) {
    if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, id) {
        let _ = entry.delete_credential();
    }
}

pub fn password_exists(id: &str) -> bool {
    !read_password(id).is_empty()
}

pub fn platform_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "darwin"
    }
    #[cfg(target_os = "windows")]
    {
        "win32"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::env::consts::OS
    }
}

pub fn snapshot(state: &RuntimeState) -> Result<AppState> {
    let drives = state
        .drives
        .read()
        .map_err(|_| anyhow::anyhow!("磁盘状态锁已损坏"))?
        .clone();
    let mut catalog = state
        .catalog
        .read()
        .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?
        .clone();
    let online_ids: HashSet<String> = drives
        .iter()
        .map(|drive| drive.uuid.clone())
        .chain(
            catalog
                .sources
                .iter()
                .filter(|source| source.online)
                .map(|source| source.uuid.clone()),
        )
        .collect();
    let online_paths: HashSet<String> = drives
        .iter()
        .map(|drive| drive.path.clone())
        .chain(
            catalog
                .sources
                .iter()
                .filter(|source| source.online)
                .map(|source| source.last_path.clone()),
        )
        .collect();
    catalog.files.retain(|file| {
        if file.source_uuid.is_empty() {
            online_paths.contains(&file.source)
        } else {
            online_ids.contains(&file.source_uuid)
        }
    });
    for repository in &mut catalog.repositories {
        repository.has_password = password_exists(&repository.id);
    }
    let stats = summarize(&catalog.files);
    Ok(AppState {
        catalog,
        stats,
        data_directory: state.data_dir.to_string_lossy().into_owned(),
        platform: platform_name().into(),
    })
}

pub fn summarize(files: &[crate::models::MediaFile]) -> Stats {
    let mut by_day: BTreeMap<String, StatsBucket> = BTreeMap::new();
    let mut by_type: BTreeMap<String, StatsBucket> = BTreeMap::new();
    let mut size = 0;
    for file in files {
        let day = DateTime::parse_from_rfc3339(&file.captured_at)
            .map(|value| value.with_timezone(&Local).format("%Y-%m-%d").to_string())
            .unwrap_or_else(|_| "未知".into());
        let day_bucket = by_day.entry(day).or_default();
        day_bucket.count += 1;
        day_bucket.size += file.size;
        let type_bucket = by_type.entry(file.extension.clone()).or_default();
        type_bucket.count += 1;
        type_bucket.size += file.size;
        size += file.size;
    }
    Stats {
        count: files.len(),
        size,
        by_day,
        by_type,
    }
}
