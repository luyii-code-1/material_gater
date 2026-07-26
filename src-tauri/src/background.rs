use crate::commands::scan_source_quiet;
use crate::media::{cleanup_virtual_library, create_virtual_library, list_drives, sample_drive_io};
use crate::models::{Drive, LibraryOptions, MappingRun, SourceRecord};
use crate::storage::{RuntimeState, save_catalog, snapshot};
use chrono::Utc;
use notify::{RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

fn window_active(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|window| {
        window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
    })
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let enabled = app
        .state::<RuntimeState>()
        .catalog
        .read()
        .ok()
        .is_none_or(|catalog| catalog.settings.notifications);
    if enabled {
        let _ = app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .auto_cancel()
            .show();
    }
}

fn remember_drive(app: &AppHandle, drive: &Drive) {
    let state = app.state::<RuntimeState>();
    let mut catalog = match state.catalog.write() {
        Ok(value) => value,
        Err(_) => return,
    };
    let now = Utc::now().to_rfc3339();
    if let Some(source) = catalog
        .sources
        .iter_mut()
        .find(|source| source.uuid == drive.uuid)
    {
        let previous = source.last_path.clone();
        source.name = drive.name.clone();
        source.last_path = drive.path.clone();
        source.last_seen = now;
        source.online = true;
        if previous != drive.path {
            for file in catalog
                .files
                .iter_mut()
                .filter(|file| file.source_uuid == drive.uuid)
            {
                file.source = drive.path.clone();
                file.path = Path::new(&drive.path)
                    .join(&file.relative_path)
                    .to_string_lossy()
                    .into_owned();
            }
        }
    } else {
        catalog.sources.push(SourceRecord {
            uuid: drive.uuid.clone(),
            name: drive.name.clone(),
            last_path: drive.path.clone(),
            last_seen: now,
            online: true,
            external: false,
        });
    }
    for mapping in &mut catalog.mappings {
        if mapping.source_uuid.is_empty() && mapping.source == drive.path {
            mapping.source_uuid = drive.uuid.clone();
        }
        if mapping.source_uuid == drive.uuid {
            mapping.source = drive.path.clone();
        }
    }
}

fn mount_known_mappings(app: &AppHandle, drive: &Drive) {
    let state = app.state::<RuntimeState>();
    let mut catalog = match state.catalog.write() {
        Ok(value) => value,
        Err(_) => return,
    };
    let files: Vec<_> = catalog
        .files
        .iter()
        .filter(|file| file.source_uuid == drive.uuid)
        .cloned()
        .collect();
    if files.is_empty() {
        return;
    }
    for mapping in catalog
        .mappings
        .iter_mut()
        .filter(|mapping| mapping.source_uuid == drive.uuid)
    {
        let options = LibraryOptions {
            id: mapping.id.clone(),
            destination: mapping.destination.clone(),
            extensions: mapping.extensions.clone(),
            start_date: mapping.start_date.clone(),
            end_date: mapping.end_date.clone(),
        };
        match create_virtual_library(&files, &options) {
            Ok(result) => {
                mapping.mounted = true;
                mapping.mount_error.clear();
                mapping.last_run = Some(MappingRun {
                    at: Utc::now().to_rfc3339(),
                    total: result.total,
                    linked: result.linked,
                    failed: result.failures.len(),
                });
            }
            Err(error) => {
                mapping.mounted = false;
                mapping.mount_error = error.to_string();
            }
        }
    }
}

pub fn watch_source(app: &AppHandle, drive: &Drive) {
    let state = app.state::<RuntimeState>();
    if let Ok(watchers) = state.source_watchers.lock()
        && watchers.contains_key(&drive.uuid)
    {
        return;
    }
    let handle = app.clone();
    let uuid = drive.uuid.clone();
    let source = drive.path.clone();
    let callback_uuid = uuid.clone();
    let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event.is_err() {
            return;
        }
        let marker = Instant::now();
        if let Ok(mut debounces) = handle.state::<RuntimeState>().scan_debounces.lock() {
            debounces.insert(callback_uuid.clone(), marker);
        }
        let app = handle.clone();
        let uuid = callback_uuid.clone();
        let source = source.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(900)).await;
            let current = app
                .state::<RuntimeState>()
                .scan_debounces
                .lock()
                .ok()
                .and_then(|values| values.get(&uuid).copied());
            if current == Some(marker) {
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    let _ = scan_source_quiet(&app, &source);
                })
                .await;
            }
        });
    });
    let Ok(mut watcher) = watcher else { return };
    if watcher
        .watch(Path::new(&drive.path), RecursiveMode::Recursive)
        .is_ok()
        && let Ok(mut watchers) = state.source_watchers.lock()
    {
        watchers.insert(uuid, watcher);
    }
}

fn handle_added(app: &AppHandle, drive: &Drive, initial: bool) {
    remember_drive(app, drive);
    mount_known_mappings(app, drive);
    watch_source(app, drive);
    let state = app.state::<RuntimeState>();
    let _ = save_catalog(&state);
    if initial {
        return;
    }
    notify(
        app,
        "素材源已连接",
        &format!("{} 已连接，已有映射已恢复", drive.name),
    );
    let settings = state
        .catalog
        .read()
        .ok()
        .map(|catalog| catalog.settings.clone())
        .unwrap_or_default();
    if !settings.ask_before_scan {
        let app = app.clone();
        let source = drive.path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _ = scan_source_quiet(&app, &source);
        });
    } else if window_active(app) {
        let _ = app.emit("drive-detected", drive);
    } else {
        notify(
            app,
            "检测到素材盘",
            &format!(
                "{} 已连接，点击通知打开 Material Gater 后选择是否扫描",
                drive.name
            ),
        );
    }
}

fn handle_removed(app: &AppHandle, drive: &Drive) {
    let state = app.state::<RuntimeState>();
    if let Ok(mut watchers) = state.source_watchers.lock() {
        watchers.remove(&drive.uuid);
    }
    let mut removed = 0;
    if let Ok(mut catalog) = state.catalog.write() {
        if let Some(source) = catalog
            .sources
            .iter_mut()
            .find(|source| source.uuid == drive.uuid)
        {
            source.online = false;
        }
        for mapping in catalog
            .mappings
            .iter_mut()
            .filter(|mapping| mapping.source_uuid == drive.uuid || mapping.source == drive.path)
        {
            removed += cleanup_virtual_library(&mapping.destination, &mapping.id)
                .map(|value| value.removed)
                .unwrap_or(0);
            mapping.mounted = false;
        }
    }
    let _ = save_catalog(&state);
    notify(
        app,
        "素材源已移除",
        &format!(
            "{} 已移除{}",
            drive.name,
            if removed > 0 {
                format!("，{removed} 个映射链接已卸载")
            } else {
                String::new()
            }
        ),
    );
    let mut payload = serde_json::to_value(drive).unwrap_or_default();
    if let Some(object) = payload.as_object_mut() {
        object.insert("removedLinks".into(), removed.into());
    }
    let _ = app.emit("source-removed", payload);
}

fn poll_once(app: &AppHandle, initial: bool) {
    let next = list_drives();
    let state = app.state::<RuntimeState>();
    let previous = state
        .drives
        .read()
        .map(|value| value.clone())
        .unwrap_or_default();
    let old: HashMap<_, _> = previous
        .iter()
        .map(|drive| (drive.uuid.clone(), drive))
        .collect();
    let new: HashMap<_, _> = next
        .iter()
        .map(|drive| (drive.uuid.clone(), drive))
        .collect();
    let topology_changed = previous.len() != next.len()
        || previous.iter().any(|drive| {
            new.get(&drive.uuid).is_none_or(|current| {
                current.path != drive.path
                    || current.name != drive.name
                    || current.device != drive.device
                    || current.kind != drive.kind
            })
        });
    for drive in previous
        .iter()
        .filter(|drive| !new.contains_key(&drive.uuid))
    {
        handle_removed(app, drive);
    }
    for drive in next.iter().filter(|drive| !old.contains_key(&drive.uuid)) {
        handle_added(app, drive, initial);
    }
    for drive in next.iter().filter(|drive| {
        old.get(&drive.uuid)
            .is_some_and(|previous| previous.path != drive.path || previous.name != drive.name)
    }) {
        if let Ok(mut watchers) = state.source_watchers.lock() {
            watchers.remove(&drive.uuid);
        }
        remember_drive(app, drive);
        mount_known_mappings(app, drive);
        watch_source(app, drive);
        let _ = save_catalog(&state);
    }
    if let Ok(mut drives) = state.drives.write() {
        *drives = next.clone();
    }
    if topology_changed {
        let _ = app.emit("drives-changed", &next);
        if let Ok(value) = snapshot(&state) {
            let _ = app.emit("state-changed", value);
        }
    }
}

pub fn start(app: AppHandle) {
    let initial = app.clone();
    tauri::async_runtime::spawn_blocking(move || poll_once(&initial, true));
    let monitor = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let interval = {
                let state = monitor.state::<RuntimeState>();
                state
                    .catalog
                    .read()
                    .ok()
                    .map(|catalog| {
                        if window_active(&monitor) {
                            catalog.settings.foreground_scan_ms
                        } else {
                            catalog.settings.background_scan_ms
                        }
                    })
                    .unwrap_or(3_000)
            };
            tokio::time::sleep(Duration::from_millis(interval.max(500))).await;
            let app = monitor.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || poll_once(&app, false)).await;
        }
    });
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let state = app.state::<RuntimeState>();
            let drives = state
                .drives
                .read()
                .map(|value| value.clone())
                .unwrap_or_default();
            let now = Instant::now();
            let elapsed = state
                .io_sampled_at
                .write()
                .map(|mut previous| {
                    let value = now.duration_since(*previous).as_secs_f64();
                    *previous = now;
                    value
                })
                .unwrap_or(1.0);
            let speeds = state
                .io_counters
                .write()
                .map(|mut counters| sample_drive_io(&drives, &mut counters, elapsed))
                .unwrap_or_default();
            let _ = app.emit("drives-io", speeds);
        }
    });
}
