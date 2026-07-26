use crate::copy_engine::{build_task, pause_task, start_task};
use crate::media::{
    cleanup_virtual_library, create_virtual_library, list_directory as read_directory,
    walk_media_with_progress,
};
use crate::models::{
    AppState, BackgroundTask, CopyPreset, CopyRequest, DeleteMappingRequest, DirectoryEntry, Drive,
    LibraryOptions, MappingInput, MappingProfile, MappingRun, Repository, RepositoryInput,
    SettingsPatch, SourceRecord,
};
use crate::repository;
use crate::storage::{RuntimeState, delete_password, save_catalog, snapshot, store_password};
use anyhow::{Context, Result, bail};
use chrono::Utc;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::menu::MenuBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use uuid::Uuid;

fn command_result<T>(result: Result<T>) -> std::result::Result<T, String> {
    result.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_state(state: State<'_, RuntimeState>) -> std::result::Result<AppState, String> {
    command_result(snapshot(&state))
}

#[tauri::command]
pub fn get_drives(state: State<'_, RuntimeState>) -> std::result::Result<Vec<Drive>, String> {
    state
        .drives
        .read()
        .map(|value| value.clone())
        .map_err(|_| "磁盘状态锁已损坏".into())
}

#[tauri::command]
pub fn get_background_tasks(
    state: State<'_, RuntimeState>,
) -> std::result::Result<Vec<BackgroundTask>, String> {
    command_result(crate::tasks::list(&state))
}

fn resolve_drive(state: &RuntimeState, source: &str) -> Drive {
    state
        .drives
        .read()
        .ok()
        .and_then(|drives| drives.iter().find(|drive| drive.path == source).cloned())
        .unwrap_or_else(|| {
            let path = Path::new(source);
            Drive {
                id: source.into(),
                uuid: source.into(),
                name: path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("素材目录")
                    .into(),
                path: source.into(),
                kind: "目录".into(),
                ..Drive::default()
            }
        })
}

fn update_source(catalog: &mut crate::models::Catalog, drive: &Drive) {
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
            external: drive.kind == "目录",
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

fn scan_source(app: &AppHandle, source: &str, quiet: bool, task_id: &str) -> Result<()> {
    let state = app.state::<RuntimeState>();
    let drive = resolve_drive(&state, source);
    let mut last_progress = Instant::now() - Duration::from_secs(1);
    let mut files = walk_media_with_progress(Path::new(&drive.path), &drive.uuid, |count| {
        if last_progress.elapsed() >= Duration::from_millis(120) {
            crate::tasks::update(
                app,
                task_id,
                Some("扫描素材库"),
                Some(format!("{} · 已发现 {count} 个素材", drive.name)),
                count as u64,
                None,
            );
            last_progress = Instant::now();
        }
    })?;
    let file_count = files.len();
    crate::tasks::update(
        app,
        task_id,
        Some("处理索引"),
        Some(format!("{} · 正在整理 {file_count} 个素材", drive.name)),
        0,
        Some(file_count as u64),
    );

    let mapping_options = state
        .catalog
        .read()
        .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?
        .mappings
        .iter()
        .filter(|mapping| mapping.source_uuid == drive.uuid)
        .map(|mapping| LibraryOptions {
            id: mapping.id.clone(),
            destination: mapping.destination.clone(),
            extensions: mapping.extensions.clone(),
            start_date: mapping.start_date.clone(),
            end_date: mapping.end_date.clone(),
        })
        .collect::<Vec<_>>();
    let mut mapping_results = Vec::with_capacity(mapping_options.len());
    for (index, options) in mapping_options.iter().enumerate() {
        crate::tasks::update(
            app,
            task_id,
            Some("处理索引"),
            Some(format!(
                "{} · 更新映射 {}/{}",
                drive.name,
                index + 1,
                mapping_options.len()
            )),
            file_count as u64,
            Some(file_count as u64),
        );
        let outcome = match create_virtual_library(&files, options) {
            Ok(result) => (
                true,
                String::new(),
                Some(MappingRun {
                    at: Utc::now().to_rfc3339(),
                    total: result.total,
                    linked: result.linked,
                    failed: result.failures.len(),
                }),
            ),
            Err(error) => (false, error.to_string(), None),
        };
        mapping_results.push((options.id.clone(), outcome));
    }
    {
        let mut catalog = state
            .catalog
            .write()
            .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?;
        catalog
            .files
            .retain(|file| file.source_uuid != drive.uuid && file.source != drive.path);
        catalog.files.append(&mut files);
        catalog.last_scan = Some(Utc::now().to_rfc3339());
        catalog.source = Some(drive.path.clone());
        update_source(&mut catalog, &drive);
        for (id, (mounted, error, run)) in mapping_results {
            if let Some(mapping) = catalog.mappings.iter_mut().find(|mapping| mapping.id == id) {
                mapping.mounted = mounted;
                mapping.mount_error = error;
                mapping.last_run = run;
            }
        }
    }
    save_catalog(&state)?;
    crate::background::watch_source(app, &drive);
    let result = snapshot(&state)?;
    let _ = app.emit("state-changed", &result);
    if !quiet {
        let _ = app.emit(
            "scan-completed",
            json!({ "uuid": drive.uuid, "name": drive.name, "count": file_count }),
        );
    }
    crate::tasks::update(
        app,
        task_id,
        Some("处理索引"),
        Some(format!("{} · 已处理 {file_count} 个素材", drive.name)),
        file_count as u64,
        Some(file_count as u64),
    );
    crate::tasks::complete(app, task_id, &drive.uuid);
    Ok(())
}

fn queue_scan(app: &AppHandle, source: &str, quiet: bool) -> Result<BackgroundTask> {
    let state = app.state::<RuntimeState>();
    let drive = resolve_drive(&state, source);
    let (task, started) = crate::tasks::begin_scan(
        app,
        &drive.uuid,
        "扫描素材库".into(),
        format!("{} · 准备读取目录", drive.name),
    )?;
    if started {
        let app = app.clone();
        let source = source.to_string();
        let task_id = task.id.clone();
        let key = drive.uuid;
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = scan_source(&app, &source, quiet, &task_id) {
                crate::tasks::fail(&app, &task_id, &key, error.to_string());
            }
        });
    }
    Ok(task)
}

#[tauri::command]
pub fn scan_media(app: AppHandle, source: String) -> std::result::Result<BackgroundTask, String> {
    command_result(queue_scan(&app, &source, false))
}

#[tauri::command]
pub async fn list_directory(
    root: String,
    relative: String,
) -> std::result::Result<Vec<DirectoryEntry>, String> {
    command_result(
        tauri::async_runtime::spawn_blocking(move || read_directory(Path::new(&root), &relative))
            .await
            .map_err(anyhow::Error::from)
            .and_then(|value| value),
    )
}

#[tauri::command]
pub fn create_library(
    state: State<'_, RuntimeState>,
    options: LibraryOptions,
) -> std::result::Result<Value, String> {
    command_result((|| {
        let files = state
            .catalog
            .read()
            .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?
            .files
            .clone();
        Ok(serde_json::to_value(create_virtual_library(
            &files, &options,
        )?)?)
    })())
}

fn validated_mapping(input: MappingInput, drives: &[Drive]) -> Result<MappingInput> {
    if input.source.is_empty() || !Path::new(&input.source).is_absolute() {
        bail!("请选择有效的素材来源");
    }
    if input.destination.is_empty()
        || !Path::new(&input.destination).is_absolute()
        || Path::new(&input.destination).parent().is_none()
    {
        bail!("请选择安全的映射目标目录");
    }
    let source_uuid = if input.source_uuid.is_empty() {
        drives
            .iter()
            .find(|drive| drive.path == input.source)
            .map(|drive| drive.uuid.clone())
            .unwrap_or_default()
    } else {
        input.source_uuid
    };
    Ok(MappingInput {
        name: if input.name.trim().is_empty() {
            "未命名映射".into()
        } else {
            input.name.trim().chars().take(80).collect()
        },
        source: input.source,
        source_uuid,
        destination: input.destination,
        extensions: input
            .extensions
            .into_iter()
            .map(|ext| ext.to_ascii_lowercase())
            .collect(),
        ..input
    })
}

#[tauri::command]
pub fn save_mapping(
    state: State<'_, RuntimeState>,
    input: MappingInput,
) -> std::result::Result<Value, String> {
    command_result((|| {
        let drives = state
            .drives
            .read()
            .map_err(|_| anyhow::anyhow!("磁盘状态锁已损坏"))?
            .clone();
        let input = validated_mapping(input, &drives)?;
        let now = Utc::now().to_rfc3339();
        let mapping = {
            let mut catalog = state
                .catalog
                .write()
                .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?;
            let index = input.id.as_ref().and_then(|id| {
                catalog
                    .mappings
                    .iter()
                    .position(|mapping| &mapping.id == id)
            });
            let previous = index.and_then(|index| catalog.mappings.get(index)).cloned();
            let mapping = MappingProfile {
                id: input.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                name: input.name,
                source: input.source,
                source_uuid: input.source_uuid,
                destination: input.destination,
                extensions: input.extensions,
                start_date: input.start_date,
                end_date: input.end_date,
                created_at: previous
                    .as_ref()
                    .map(|value| value.created_at.clone())
                    .unwrap_or_else(|| now.clone()),
                updated_at: now,
                mounted: previous.as_ref().is_some_and(|value| value.mounted),
                mount_error: previous
                    .as_ref()
                    .map(|value| value.mount_error.clone())
                    .unwrap_or_default(),
                last_run: previous.and_then(|value| value.last_run),
            };
            if let Some(index) = index {
                catalog.mappings[index] = mapping.clone();
            } else {
                catalog.mappings.push(mapping.clone());
            }
            mapping
        };
        save_catalog(&state)?;
        Ok(json!({ "state": snapshot(&state)?, "mapping": mapping }))
    })())
}

#[tauri::command]
pub fn run_mapping(
    state: State<'_, RuntimeState>,
    id: String,
) -> std::result::Result<Value, String> {
    command_result((|| {
        let (mapping, files) = {
            let catalog = state
                .catalog
                .read()
                .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?;
            let mapping = catalog
                .mappings
                .iter()
                .find(|mapping| mapping.id == id)
                .cloned()
                .context("找不到该映射")?;
            let files: Vec<_> = catalog
                .files
                .iter()
                .filter(|file| {
                    if mapping.source_uuid.is_empty() {
                        file.source == mapping.source
                    } else {
                        file.source_uuid == mapping.source_uuid
                    }
                })
                .cloned()
                .collect();
            (mapping, files)
        };
        if files.is_empty() {
            bail!("该来源尚未建立索引");
        }
        let options = LibraryOptions {
            id: mapping.id.clone(),
            destination: mapping.destination.clone(),
            extensions: mapping.extensions.clone(),
            start_date: mapping.start_date.clone(),
            end_date: mapping.end_date.clone(),
        };
        let result = create_virtual_library(&files, &options)?;
        {
            let mut catalog = state
                .catalog
                .write()
                .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?;
            if let Some(value) = catalog
                .mappings
                .iter_mut()
                .find(|value| value.id == mapping.id)
            {
                value.mounted = true;
                value.mount_error.clear();
                value.last_run = Some(MappingRun {
                    at: Utc::now().to_rfc3339(),
                    total: result.total,
                    linked: result.linked,
                    failed: result.failures.len(),
                });
            }
        }
        save_catalog(&state)?;
        Ok(json!({ "state": snapshot(&state)?, "result": result }))
    })())
}

#[tauri::command]
pub fn delete_mapping(
    state: State<'_, RuntimeState>,
    request: DeleteMappingRequest,
) -> std::result::Result<Value, String> {
    command_result((|| {
        let mapping = state
            .catalog
            .read()
            .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?
            .mappings
            .iter()
            .find(|mapping| mapping.id == request.id)
            .cloned()
            .context("找不到该映射")?;
        let cleanup = request
            .cleanup
            .then(|| cleanup_virtual_library(&mapping.destination, &mapping.id))
            .transpose()?;
        state
            .catalog
            .write()
            .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?
            .mappings
            .retain(|value| value.id != mapping.id);
        save_catalog(&state)?;
        Ok(json!({ "state": snapshot(&state)?, "cleanup": cleanup }))
    })())
}

fn validate_repository(input: RepositoryInput) -> Result<RepositoryInput> {
    if input.name.trim().is_empty() {
        bail!("请输入储存库名称");
    }
    if !["local", "smb", "ftp", "sftp"].contains(&input.repository_type.as_str()) {
        bail!("不支持的储存库类型");
    }
    if input.repository_type == "local"
        && (input.root.is_empty() || !Path::new(&input.root).is_absolute())
    {
        bail!("请选择储存库目录");
    }
    if input.repository_type != "local" && input.address.trim().is_empty() {
        bail!("请输入远程地址");
    }
    Ok(input)
}

#[tauri::command]
pub fn save_repository(
    state: State<'_, RuntimeState>,
    input: RepositoryInput,
) -> std::result::Result<AppState, String> {
    command_result((|| {
        let input = validate_repository(input)?;
        let id = input
            .id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let repository = Repository {
            id: id.clone(),
            name: input.name.trim().chars().take(80).collect(),
            repository_type: input.repository_type,
            root: input.root,
            address: input.address.trim().into(),
            remote_path: input.remote_path.trim().into(),
            username: input.username.trim().into(),
            domain: input.domain.trim().into(),
            port: input.port,
            has_password: !input.password.is_empty(),
            is_default: input.is_default,
            default_path_template: if input.default_path_template.trim().is_empty() {
                "%day/%note".into()
            } else {
                input.default_path_template.trim().into()
            },
            default_mode: if input.default_mode == "original" {
                "original".into()
            } else {
                "flat".into()
            },
            created_at: Utc::now().to_rfc3339(),
        };
        {
            let mut catalog = state
                .catalog
                .write()
                .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?;
            if repository.is_default {
                for value in &mut catalog.repositories {
                    value.is_default = false;
                }
            }
            if let Some(index) = catalog.repositories.iter().position(|value| value.id == id) {
                let created_at = catalog.repositories[index].created_at.clone();
                catalog.repositories[index] = Repository {
                    created_at,
                    ..repository.clone()
                };
            } else {
                catalog.repositories.push(repository);
            }
            if !catalog.repositories.iter().any(|value| value.is_default)
                && let Some(value) = catalog.repositories.first_mut()
            {
                value.is_default = true;
            }
        }
        store_password(&id, &input.password)?;
        save_catalog(&state)?;
        snapshot(&state)
    })())
}

#[tauri::command]
pub async fn test_repository(input: RepositoryInput) -> std::result::Result<Value, String> {
    command_result(
        async {
            let input = validate_repository(input)?;
            let password = if input.password.is_empty() {
                input
                    .id
                    .as_deref()
                    .map(crate::storage::read_password)
                    .unwrap_or_default()
            } else {
                input.password.clone()
            };
            let repository = Repository {
                id: input.id.unwrap_or_else(|| "test".into()),
                name: input.name,
                repository_type: input.repository_type,
                root: input.root,
                address: input.address,
                remote_path: input.remote_path,
                username: input.username,
                domain: input.domain,
                port: input.port,
                has_password: !password.is_empty(),
                is_default: input.is_default,
                default_path_template: input.default_path_template,
                default_mode: input.default_mode,
                created_at: Utc::now().to_rfc3339(),
            };
            let message = repository::test_repository(&repository, &password).await?;
            Ok(json!({ "ok": true, "message": message }))
        }
        .await,
    )
}

#[tauri::command]
pub fn delete_repository(
    state: State<'_, RuntimeState>,
    id: String,
) -> std::result::Result<AppState, String> {
    command_result((|| {
        let mut catalog = state
            .catalog
            .write()
            .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?;
        let default = catalog
            .repositories
            .iter()
            .find(|value| value.id == id)
            .is_some_and(|value| value.is_default);
        catalog.repositories.retain(|value| value.id != id);
        if default && let Some(value) = catalog.repositories.first_mut() {
            value.is_default = true;
        }
        drop(catalog);
        delete_password(&id);
        save_catalog(&state)?;
        snapshot(&state)
    })())
}

#[tauri::command]
pub fn save_preset(
    state: State<'_, RuntimeState>,
    mut input: CopyPreset,
) -> std::result::Result<AppState, String> {
    command_result((|| {
        if input.name.trim().is_empty() {
            bail!("请输入预设名称");
        }
        if input.id.is_empty() {
            input.id = Uuid::new_v4().to_string();
        }
        input.updated_at = Utc::now().to_rfc3339();
        let mut catalog = state
            .catalog
            .write()
            .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?;
        if let Some(index) = catalog
            .presets
            .iter()
            .position(|value| value.id == input.id)
        {
            catalog.presets[index] = input;
        } else {
            catalog.presets.push(input);
        }
        drop(catalog);
        save_catalog(&state)?;
        snapshot(&state)
    })())
}

#[tauri::command]
pub fn delete_preset(
    state: State<'_, RuntimeState>,
    id: String,
) -> std::result::Result<AppState, String> {
    command_result((|| {
        state
            .catalog
            .write()
            .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?
            .presets
            .retain(|value| value.id != id);
        save_catalog(&state)?;
        snapshot(&state)
    })())
}

#[tauri::command]
pub fn create_copy_task(app: AppHandle, input: CopyRequest) -> std::result::Result<Value, String> {
    command_result((|| {
        let state = app.state::<RuntimeState>();
        let (files, repository) = {
            let catalog = state
                .catalog
                .read()
                .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?;
            (
                catalog
                    .files
                    .iter()
                    .filter(|file| file.source_uuid == input.source_uuid)
                    .cloned()
                    .collect::<Vec<_>>(),
                catalog
                    .repositories
                    .iter()
                    .find(|repository| repository.id == input.repository_id)
                    .cloned()
                    .context("找不到目标储存库")?,
            )
        };
        let task = build_task(&files, &repository, &input)?;
        state
            .catalog
            .write()
            .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?
            .tasks
            .insert(0, task.clone());
        save_catalog(&state)?;
        start_task(&app, &task.id)?;
        Ok(json!({ "state": snapshot(&state)?, "task": task }))
    })())
}

#[tauri::command]
pub fn pause_copy_task(app: AppHandle, id: String) -> std::result::Result<AppState, String> {
    command_result((|| {
        pause_task(&app, &id)?;
        snapshot(&app.state::<RuntimeState>())
    })())
}

#[tauri::command]
pub fn resume_copy_task(app: AppHandle, id: String) -> std::result::Result<AppState, String> {
    command_result((|| {
        start_task(&app, &id)?;
        snapshot(&app.state::<RuntimeState>())
    })())
}

#[tauri::command]
pub fn save_settings(
    state: State<'_, RuntimeState>,
    values: SettingsPatch,
) -> std::result::Result<AppState, String> {
    command_result((|| {
        let mut catalog = state
            .catalog
            .write()
            .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?;
        if let Some(value) = values.foreground_scan_ms {
            catalog.settings.foreground_scan_ms = value.max(500);
        }
        if let Some(value) = values.background_scan_ms {
            catalog.settings.background_scan_ms = value.max(1_000);
        }
        if let Some(value) = values.ask_before_scan {
            catalog.settings.ask_before_scan = value;
        }
        if let Some(value) = values.notifications {
            catalog.settings.notifications = value;
        }
        if let Some(value) = values.keep_running {
            catalog.settings.keep_running = value;
        }
        drop(catalog);
        save_catalog(&state)?;
        snapshot(&state)
    })())
}

#[tauri::command]
pub fn clear_catalog(state: State<'_, RuntimeState>) -> std::result::Result<AppState, String> {
    command_result((|| {
        let mut catalog = state
            .catalog
            .write()
            .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?;
        catalog.files.clear();
        catalog.last_scan = None;
        catalog.source = None;
        drop(catalog);
        save_catalog(&state)?;
        snapshot(&state)
    })())
}

#[tauri::command]
pub fn show_window(window: WebviewWindow) -> std::result::Result<(), String> {
    command_result((|| {
        if window.is_minimized()? {
            window.unminimize()?;
        }
        window.show()?;
        window.set_focus()?;
        Ok(())
    })())
}

#[tauri::command]
pub fn show_media_menu(
    app: AppHandle,
    window: WebviewWindow,
    target: String,
) -> std::result::Result<(), String> {
    command_result((|| {
        let target = PathBuf::from(target);
        if !target.is_absolute() {
            bail!("无效路径");
        }
        *app.state::<RuntimeState>()
            .context_target
            .write()
            .map_err(|_| anyhow::anyhow!("菜单状态锁已损坏"))? = Some(target);
        let menu = MenuBuilder::new(&app)
            .text("open-media", "打开")
            .text("reveal-media", "打开文件所在位置")
            .build()?;
        window.popup_menu(&menu)?;
        Ok(())
    })())
}

pub fn scan_source_quiet(app: &AppHandle, source: &str) -> Result<BackgroundTask> {
    queue_scan(app, source, true)
}
