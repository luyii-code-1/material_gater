use crate::models::{CopyFileState, CopyRequest, CopyTask, MediaFile, Repository};
use crate::repository::{copy_remote_fs, copy_smb, hash_remote_fs, hash_smb};
use crate::storage::{RuntimeState, read_password, save_catalog};
use anyhow::{Context, Result, bail};
use chrono::{DateTime, Local, NaiveDate, Utc};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::fs::{self, File, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom};
use tokio::sync::mpsc;
use uuid::Uuid;

fn local_day(value: &str) -> String {
    DateTime::parse_from_rfc3339(value)
        .map(|date| date.with_timezone(&Local).format("%Y-%m-%d").to_string())
        .unwrap_or_else(|_| Local::now().format("%Y-%m-%d").to_string())
}

fn local_time(value: &str) -> String {
    DateTime::parse_from_rfc3339(value)
        .map(|date| date.with_timezone(&Local).format("%H-%M-%S").to_string())
        .unwrap_or_else(|_| "00-00-00".into())
}

fn safe_segment(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            ) || character.is_control()
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim()
        .to_string()
}

fn expand_template(template: &str, file: &MediaFile, note: &str) -> PathBuf {
    let inline_note = regex::Regex::new(r#"%note\("([^"]*)"\)"#).expect("valid regex");
    let expanded = inline_note
        .replace_all(template.trim(), |captures: &regex::Captures<'_>| {
            safe_segment(&captures[1])
        })
        .replace("%day", &local_day(&file.captured_at))
        .replace("%time", &local_time(&file.captured_at))
        .replace("%note", &safe_segment(note));
    expanded
        .split(['/', '\\'])
        .map(safe_segment)
        .filter(|value| !value.is_empty())
        .collect()
}

fn safe_relative(value: &str) -> PathBuf {
    Path::new(value)
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(safe_segment(&value.to_string_lossy())),
            _ => None,
        })
        .collect()
}

fn selected(files: &[MediaFile], request: &CopyRequest) -> Vec<MediaFile> {
    let ids: HashSet<&str> = request
        .selection
        .file_ids
        .iter()
        .map(String::as_str)
        .collect();
    let extensions: HashSet<String> = request
        .selection
        .extensions
        .iter()
        .map(|value| value.to_ascii_lowercase())
        .collect();
    let start = NaiveDate::parse_from_str(&request.selection.start_date, "%Y-%m-%d").ok();
    let end = NaiveDate::parse_from_str(&request.selection.end_date, "%Y-%m-%d").ok();
    files
        .iter()
        .filter(|file| {
            let day = DateTime::parse_from_rfc3339(&file.captured_at)
                .map(|date| date.with_timezone(&Local).date_naive())
                .ok();
            (ids.is_empty() || ids.contains(file.id.as_str()))
                && (extensions.is_empty()
                    || extensions.contains(&file.extension.to_ascii_lowercase()))
                && day.is_none_or(|day| {
                    start.is_none_or(|start| day >= start) && end.is_none_or(|end| day <= end)
                })
        })
        .cloned()
        .collect()
}

pub fn build_task(
    files: &[MediaFile],
    repository: &Repository,
    input: &CopyRequest,
) -> Result<CopyTask> {
    let selected = selected(files, input);
    if selected.is_empty() {
        bail!("没有选择需要拷贝的素材");
    }
    if repository.repository_type == "local"
        && (repository.root.is_empty() || !Path::new(&repository.root).is_absolute())
    {
        bail!("储存库目录无效");
    }
    let mut used: HashMap<String, usize> = HashMap::new();
    let mut items = Vec::with_capacity(selected.len());
    for file in selected {
        let folder = expand_template(&input.path_template, &file, &input.note);
        let mut relative = if input.mode == "original" {
            folder.join(safe_relative(&file.relative_path))
        } else {
            folder.join(safe_segment(&file.name))
        };
        let key = relative.to_string_lossy().to_ascii_lowercase();
        let count = used.entry(key).or_default();
        if *count > 0 {
            let stem = relative
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("素材");
            let ext = relative
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| format!(".{value}"))
                .unwrap_or_default();
            relative.set_file_name(format!("{stem}-{}{ext}", *count + 1));
        }
        *count += 1;
        items.push(CopyFileState {
            id: Uuid::new_v4().to_string(),
            source: file.path,
            relative: relative.to_string_lossy().into_owned(),
            size: file.size,
            copied: 0,
            status: "queued".into(),
            error: String::new(),
            source_hash: String::new(),
            verify_status: "pending".into(),
            verify_error: String::new(),
        });
    }
    let total_bytes = items.iter().map(|file| file.size).sum();
    let now = Utc::now().to_rfc3339();
    Ok(CopyTask {
        id: Uuid::new_v4().to_string(),
        name: if input.name.trim().is_empty() {
            format!("拷贝 {}", Local::now().format("%Y-%m-%d"))
        } else {
            input.name.trim().chars().take(80).collect()
        },
        repository_id: repository.id.clone(),
        destination_root: input.destination_root.clone(),
        source_uuid: input.source_uuid.clone(),
        status: "queued".into(),
        total_bytes,
        copied_bytes: 0,
        speed: 0.0,
        eta: None,
        history: vec![],
        verify_status: "queued".into(),
        verified_bytes: 0,
        verify_speed: 0.0,
        verify_eta: None,
        verify_history: vec![],
        verify_error: String::new(),
        files: items,
        error: String::new(),
        path_template: input.path_template.clone(),
        note: input.note.clone(),
        mode: if input.mode == "original" {
            "original".into()
        } else {
            "flat".into()
        },
        created_at: now.clone(),
        updated_at: now,
    })
}

fn task_and_repository(state: &RuntimeState, id: &str) -> Result<(CopyTask, Repository)> {
    let catalog = state
        .catalog
        .read()
        .map_err(|_| anyhow::anyhow!("文件索引锁已损坏"))?;
    let task = catalog
        .tasks
        .iter()
        .find(|task| task.id == id)
        .cloned()
        .context("找不到拷贝任务")?;
    let repository = if !task.destination_root.is_empty() {
        Repository {
            id: task.repository_id.clone(),
            name: "临时目标文件夹".into(),
            repository_type: "local".into(),
            root: task.destination_root.clone(),
            ..Repository::default()
        }
    } else {
        catalog
            .repositories
            .iter()
            .find(|repository| repository.id == task.repository_id)
            .cloned()
            .context("储存位置已被删除")?
    };
    Ok((task, repository))
}

fn update_task<F>(app: &AppHandle, id: &str, update: F) -> Result<CopyTask>
where
    F: FnOnce(&mut CopyTask),
{
    let state = app.state::<RuntimeState>();
    let task = {
        let mut catalog = state
            .catalog
            .write()
            .map_err(|_| anyhow::anyhow!("文件索引锁已损坏"))?;
        let task = catalog
            .tasks
            .iter_mut()
            .find(|task| task.id == id)
            .context("找不到拷贝任务")?;
        update(task);
        task.updated_at = Utc::now().to_rfc3339();
        task.clone()
    };
    save_catalog(&state)?;
    let tasks = state
        .catalog
        .read()
        .map_err(|_| anyhow::anyhow!("文件索引锁已损坏"))?
        .tasks
        .clone();
    let _ = app.emit("copy-changed", tasks);
    Ok(task)
}

async fn hash_local_file(
    path: &Path,
    pause: &AtomicBool,
    mut progress: impl FnMut(u64) -> Result<()>,
) -> Result<String> {
    let mut file = File::open(path)
        .await
        .with_context(|| format!("无法读取文件进行校验：{}", path.display()))?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0_u8; 4 * 1024 * 1024];
    let mut read_total = 0_u64;
    loop {
        if pause.load(Ordering::Relaxed) {
            bail!("任务已暂停");
        }
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        read_total += read as u64;
        progress(read_total)?;
    }
    Ok(hasher.finalize().to_hex().to_string())
}

async fn copy_local_file(
    source: &Path,
    destination: &Path,
    pause: &AtomicBool,
    mut progress: impl FnMut(u64, u64) -> Result<()>,
) -> Result<bool> {
    let source_size = fs::metadata(source)
        .await
        .with_context(|| format!("无法读取素材：{}", source.display()))?
        .len();
    if let Ok(metadata) = fs::metadata(destination).await
        && metadata.len() == source_size
    {
        return Ok(true);
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).await?;
    }
    let partial = PathBuf::from(format!(
        "{}.material-gater.part",
        destination.to_string_lossy()
    ));
    let mut offset = fs::metadata(&partial)
        .await
        .map(|value| value.len())
        .unwrap_or(0);
    if offset > source_size {
        fs::remove_file(&partial).await.ok();
        offset = 0;
    }
    let mut reader = File::open(source).await?;
    reader.seek(SeekFrom::Start(offset)).await?;
    let mut writer = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(offset == 0)
        .open(&partial)
        .await?;
    writer.seek(SeekFrom::Start(offset)).await?;
    progress(0, offset)?;
    let mut buffer = vec![0_u8; 4 * 1024 * 1024];
    while offset < source_size {
        if pause.load(Ordering::Relaxed) {
            bail!("任务已暂停");
        }
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read]).await?;
        offset += read as u64;
        progress(read as u64, offset)?;
    }
    writer.flush().await?;
    writer.sync_all().await?;
    if offset != source_size {
        bail!("文件读取未完成");
    }
    if fs::metadata(destination).await.is_ok() {
        fs::remove_file(destination).await?;
    }
    fs::rename(partial, destination).await?;
    Ok(false)
}

fn progress_reporter(
    app: AppHandle,
    task_id: String,
    file_id: String,
) -> impl FnMut(u64, u64) -> Result<()> + Send + 'static {
    let mut window_bytes = 0_u64;
    let mut window_started = Instant::now();
    let mut last_update = Instant::now() - Duration::from_secs(1);
    move |bytes, copied| {
        window_bytes += bytes;
        if last_update.elapsed() >= Duration::from_millis(450) || bytes == 0 {
            let elapsed = window_started.elapsed().as_secs_f64().max(0.01);
            let speed = window_bytes as f64 / elapsed;
            update_task(&app, &task_id, |task| {
                if let Some(value) = task.files.iter_mut().find(|value| value.id == file_id) {
                    value.copied = copied;
                }
                task.copied_bytes = task
                    .files
                    .iter()
                    .map(|value| value.copied.min(value.size))
                    .sum();
                task.speed = speed;
                task.eta = (speed > 0.0).then(|| {
                    ((task.total_bytes.saturating_sub(task.copied_bytes)) as f64 / speed).ceil()
                        as u64
                });
                task.history.push(speed);
                if task.history.len() > 80 {
                    task.history.drain(..task.history.len() - 80);
                }
            })?;
            window_bytes = 0;
            window_started = Instant::now();
            last_update = Instant::now();
        }
        Ok(())
    }
}

#[derive(Clone)]
struct VerificationJob {
    file_id: String,
    relative: String,
    source_hash: String,
    size: u64,
}

fn verification_progress(
    app: AppHandle,
    task_id: String,
    file_id: String,
    file_size: u64,
) -> impl FnMut(u64) -> Result<()> + Send + 'static {
    let started = Instant::now();
    let mut last_update = Instant::now() - Duration::from_secs(1);
    move |current| {
        if last_update.elapsed() >= Duration::from_millis(450) || current == file_size {
            let speed = current as f64 / started.elapsed().as_secs_f64().max(0.01);
            update_task(&app, &task_id, |task| {
                let completed: u64 = task
                    .files
                    .iter()
                    .filter(|file| file.verify_status == "verified")
                    .map(|file| file.size)
                    .sum();
                task.verified_bytes = completed.saturating_add(current.min(file_size));
                task.verify_speed = speed;
                task.verify_eta = (speed > 0.0).then(|| {
                    ((task.total_bytes.saturating_sub(task.verified_bytes)) as f64 / speed).ceil()
                        as u64
                });
                task.verify_history.push(speed);
                if task.verify_history.len() > 80 {
                    task.verify_history.drain(..task.verify_history.len() - 80);
                }
                if let Some(file) = task.files.iter_mut().find(|file| file.id == file_id) {
                    file.verify_status = "verifying".into();
                }
            })?;
            last_update = Instant::now();
        }
        Ok(())
    }
}

fn finish_transfer_phase(task: &mut CopyTask) {
    for file in &mut task.files {
        file.copied = file.size;
        if matches!(file.status.as_str(), "queued" | "copying" | "hashing") {
            file.status = "copied".into();
        }
    }
    task.copied_bytes = task.total_bytes;
    task.status = "verifying".into();
    task.speed = 0.0;
    task.eta = Some(0);
}

async fn verify_job(
    app: &AppHandle,
    task_id: &str,
    repository: &Repository,
    password: &str,
    pause: Arc<AtomicBool>,
    job: VerificationJob,
) -> Result<()> {
    update_task(app, task_id, |task| {
        task.verify_status = "running".into();
        if let Some(file) = task.files.iter_mut().find(|file| file.id == job.file_id) {
            file.verify_status = "verifying".into();
            file.verify_error.clear();
        }
    })?;
    let progress = verification_progress(
        app.clone(),
        task_id.to_string(),
        job.file_id.clone(),
        job.size,
    );
    let destination_hash = match repository.repository_type.as_str() {
        "local" => {
            let destination = Path::new(&repository.root).join(safe_relative(&job.relative));
            hash_local_file(&destination, &pause, progress).await?
        }
        "smb" => hash_smb(repository, password, &job.relative, pause.clone(), progress).await?,
        "ftp" | "sftp" => {
            let repository = repository.clone();
            let password = password.to_string();
            let relative = job.relative.clone();
            tauri::async_runtime::spawn_blocking(move || {
                hash_remote_fs(&repository, &password, &relative, pause, progress)
            })
            .await??
        }
        _ => bail!("不支持的储存库类型"),
    };
    if destination_hash != job.source_hash {
        let message = format!("文件校验失败：{}", job.relative);
        update_task(app, task_id, |task| {
            task.verify_status = "failed".into();
            task.verify_error = message.clone();
            if let Some(file) = task.files.iter_mut().find(|file| file.id == job.file_id) {
                file.verify_status = "failed".into();
                file.verify_error = message.clone();
                file.status = "failed".into();
            }
        })?;
        bail!(message);
    }
    update_task(app, task_id, |task| {
        if let Some(file) = task.files.iter_mut().find(|file| file.id == job.file_id) {
            file.verify_status = "verified".into();
            file.verify_error.clear();
            file.status = "completed".into();
        }
        task.verified_bytes = task
            .files
            .iter()
            .filter(|file| file.verify_status == "verified")
            .map(|file| file.size)
            .sum();
    })?;
    Ok(())
}

async fn execute_pipeline(
    app: &AppHandle,
    task: &CopyTask,
    repository: &Repository,
    password: &str,
    pause: Arc<AtomicBool>,
) -> Result<()> {
    let (verify_tx, mut verify_rx) = mpsc::channel::<VerificationJob>(2);
    let verify_app = app.clone();
    let verify_task_id = task.id.clone();
    let verify_repository = repository.clone();
    let verify_password = password.to_string();
    let verify_pause = pause.clone();
    let verifier = tauri::async_runtime::spawn(async move {
        while let Some(job) = verify_rx.recv().await {
            verify_job(
                &verify_app,
                &verify_task_id,
                &verify_repository,
                &verify_password,
                verify_pause.clone(),
                job,
            )
            .await?;
        }
        Ok::<_, anyhow::Error>(())
    });

    for original in task.files.clone() {
        if original.verify_status == "verified" {
            continue;
        }
        if pause.load(Ordering::Relaxed) {
            bail!("任务已暂停");
        }
        let mut file = update_task(app, &task.id, |_| {})?
            .files
            .into_iter()
            .find(|file| file.id == original.id)
            .unwrap_or(original);
        if file.source_hash.is_empty() {
            update_task(app, &task.id, |task| {
                if let Some(value) = task.files.iter_mut().find(|value| value.id == file.id) {
                    value.status = "hashing".into();
                    value.error.clear();
                }
            })?;
            let source_hash = hash_local_file(Path::new(&file.source), &pause, |_| Ok(())).await?;
            file.source_hash = source_hash.clone();
            update_task(app, &task.id, |task| {
                if let Some(value) = task.files.iter_mut().find(|value| value.id == file.id) {
                    value.source_hash = source_hash;
                    value.status = "queued".into();
                }
            })?;
        }

        if file.status != "copied" && file.status != "completed" {
            update_task(app, &task.id, |task| {
                if let Some(value) = task.files.iter_mut().find(|value| value.id == file.id) {
                    value.status = "copying".into();
                    value.error.clear();
                }
            })?;
            let progress = progress_reporter(app.clone(), task.id.clone(), file.id.clone());
            match repository.repository_type.as_str() {
                "local" => {
                    let destination =
                        Path::new(&repository.root).join(safe_relative(&file.relative));
                    copy_local_file(Path::new(&file.source), &destination, &pause, progress)
                        .await?;
                }
                "smb" => {
                    copy_smb(
                        repository,
                        password,
                        Path::new(&file.source),
                        &file.relative,
                        pause.clone(),
                        progress,
                    )
                    .await?;
                }
                "ftp" | "sftp" => {
                    let repository = repository.clone();
                    let password = password.to_string();
                    let source = PathBuf::from(&file.source);
                    let relative = file.relative.clone();
                    let transfer_pause = pause.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        copy_remote_fs(
                            &repository,
                            &password,
                            &source,
                            &relative,
                            transfer_pause,
                            progress,
                        )
                    })
                    .await??;
                }
                _ => bail!("不支持的储存库类型"),
            }
            update_task(app, &task.id, |task| {
                if let Some(value) = task.files.iter_mut().find(|value| value.id == file.id) {
                    value.copied = value.size;
                    value.status = "copied".into();
                    value.verify_status = "queued".into();
                }
                task.copied_bytes = task
                    .files
                    .iter()
                    .map(|value| value.copied.min(value.size))
                    .sum();
            })?;
        }
        verify_tx
            .send(VerificationJob {
                file_id: file.id,
                relative: file.relative,
                source_hash: file.source_hash,
                size: file.size,
            })
            .await
            .map_err(|_| anyhow::anyhow!("文件校验任务意外结束"))?;
    }
    drop(verify_tx);
    update_task(app, &task.id, finish_transfer_phase)?;
    verifier.await??;
    Ok(())
}

async fn execute_task(app: AppHandle, id: String, pause: Arc<AtomicBool>) {
    let state = app.state::<RuntimeState>();
    let Ok((task, repository)) = task_and_repository(&state, &id) else {
        if owns_task_control(&state, &id, &pause) {
            let _ = update_task(&app, &id, |task| {
                task.status = "failed".into();
                task.error = "储存库已被删除".into();
            });
        }
        release_task_control(&state, &id, &pause);
        crate::power::set_reason(&app, format!("copy:{id}"), false);
        return;
    };
    let password = read_password(&repository.id);
    let result = execute_pipeline(&app, &task, &repository, &password, pause.clone()).await;
    if owns_task_control(&state, &id, &pause) {
        match result {
            Ok(()) => {
                if let Ok(completed) = update_task(&app, &id, |task| {
                    task.status = "completed".into();
                    task.copied_bytes = task.total_bytes;
                    task.speed = 0.0;
                    task.eta = Some(0);
                    task.error.clear();
                    task.verify_status = "completed".into();
                    task.verified_bytes = task.total_bytes;
                    task.verify_speed = 0.0;
                    task.verify_eta = Some(0);
                    task.verify_error.clear();
                }) {
                    let background = app.get_webview_window("main").is_none_or(|window| {
                        !window.is_visible().unwrap_or(false)
                            || !window.is_focused().unwrap_or(false)
                    });
                    let enabled = state
                        .catalog
                        .read()
                        .ok()
                        .is_none_or(|catalog| catalog.settings.notifications);
                    if background && enabled {
                        let _ = app
                            .notification()
                            .builder()
                            .title("拷贝完成")
                            .body(format!(
                                "{} · {} 个文件",
                                completed.name,
                                completed.files.len()
                            ))
                            .auto_cancel()
                            .show();
                    }
                }
            }
            Err(_error) if pause.load(Ordering::Relaxed) => {
                let _ = update_task(&app, &id, |task| {
                    task.status = "paused".into();
                    task.speed = 0.0;
                    task.error.clear();
                    task.verify_status = "paused".into();
                    task.verify_speed = 0.0;
                    if let Some(file) = task.files.iter_mut().find(|file| file.status == "copying")
                    {
                        file.status = "queued".into();
                    }
                    for file in &mut task.files {
                        if file.status == "hashing" {
                            file.status = "queued".into();
                        }
                        if file.verify_status == "verifying" {
                            file.verify_status = "queued".into();
                        }
                    }
                });
            }
            Err(error) => {
                let message = error.to_string();
                let _ = update_task(&app, &id, |task| {
                    task.status = "failed".into();
                    task.speed = 0.0;
                    task.error = message.clone();
                    if task.verify_status == "running" {
                        task.verify_status = "failed".into();
                        task.verify_error = message.clone();
                    }
                    if let Some(file) = task.files.iter_mut().find(|file| file.status == "copying")
                    {
                        file.status = "failed".into();
                        file.error = message;
                    }
                });
            }
        }
    }
    release_task_control(&state, &id, &pause);
    crate::power::set_reason(&app, format!("copy:{id}"), false);
}

fn owns_task_control(state: &RuntimeState, id: &str, pause: &Arc<AtomicBool>) -> bool {
    state
        .pauses
        .read()
        .ok()
        .and_then(|values| values.get(id).cloned())
        .is_some_and(|current| Arc::ptr_eq(&current, pause))
}

fn release_task_control(state: &RuntimeState, id: &str, pause: &Arc<AtomicBool>) {
    if let Ok(mut values) = state.pauses.write() {
        let owns_control = values
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(current, pause));
        if owns_control {
            values.remove(id);
        }
    }
}

pub fn start_task(app: &AppHandle, id: &str) -> Result<()> {
    let state = app.state::<RuntimeState>();
    {
        let catalog = state
            .catalog
            .read()
            .map_err(|_| anyhow::anyhow!("文件索引锁已损坏"))?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.id == id)
            .context("找不到拷贝任务")?;
        if task.status == "running"
            || task.status == "verifying"
            || (task.status == "completed" && task.verify_status == "completed")
        {
            return Ok(());
        }
    }
    let pause = Arc::new(AtomicBool::new(false));
    let previous = state
        .pauses
        .write()
        .map_err(|_| anyhow::anyhow!("任务锁已损坏"))?
        .insert(id.into(), pause.clone());
    if let Some(previous) = previous {
        previous.store(true, Ordering::Relaxed);
    }
    if let Err(error) = update_task(app, id, |task| {
        task.status = "running".into();
        task.verify_status = "queued".into();
        task.error.clear();
        task.copied_bytes = task
            .files
            .iter()
            .map(|file| file.copied.min(file.size))
            .sum();
    }) {
        release_task_control(&state, id, &pause);
        return Err(error);
    }
    crate::power::set_reason(app, format!("copy:{id}"), true);
    let app = app.clone();
    let id = id.to_string();
    tauri::async_runtime::spawn(execute_task(app, id, pause));
    Ok(())
}

pub fn pause_task(app: &AppHandle, id: &str) -> Result<()> {
    let state = app.state::<RuntimeState>();
    {
        let catalog = state
            .catalog
            .read()
            .map_err(|_| anyhow::anyhow!("文件索引锁已损坏"))?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.id == id)
            .context("找不到拷贝任务")?;
        if !matches!(task.status.as_str(), "running" | "verifying" | "queued") {
            bail!("只有运行中或等待中的任务可以暂停");
        }
    }
    let pause = state
        .pauses
        .read()
        .map_err(|_| anyhow::anyhow!("任务锁已损坏"))?
        .get(id)
        .cloned()
        .context("任务执行器已经结束")?;
    pause.store(true, Ordering::Relaxed);
    crate::power::set_reason(app, format!("copy:{id}"), false);
    update_task(app, id, |task| {
        task.status = "paused".into();
        task.verify_status = "paused".into();
        task.speed = 0.0;
        task.verify_speed = 0.0;
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media(path: &Path) -> MediaFile {
        MediaFile {
            id: "media-1".into(),
            name: "clip.mov".into(),
            path: path.to_string_lossy().into_owned(),
            relative_path: "DCIM/clip.mov".into(),
            extension: ".mov".into(),
            size: 1024,
            captured_at: "2026-07-26T08:09:10+08:00".into(),
            source_uuid: "source".into(),
            ..MediaFile::default()
        }
    }

    #[test]
    fn task_expands_templates_and_original_paths() {
        let file = media(Path::new("/tmp/clip.mov"));
        let repository = Repository {
            id: "repo".into(),
            repository_type: "local".into(),
            root: "/tmp/vault".into(),
            ..Repository::default()
        };
        let request = CopyRequest {
            source_uuid: "source".into(),
            repository_id: "repo".into(),
            path_template: "%day/%note(\"悟3\")/%time".into(),
            mode: "original".into(),
            selection: crate::models::CopySelection {
                file_ids: vec!["media-1".into()],
                ..crate::models::CopySelection::default()
            },
            ..CopyRequest::default()
        };
        let task = build_task(&[file], &repository, &request).expect("task");
        assert!(task.files[0].relative.contains("2026-07-26"));
        assert!(task.files[0].relative.contains("悟3"));
        assert!(
            task.files[0]
                .relative
                .ends_with(&format!("DCIM{}clip.mov", std::path::MAIN_SEPARATOR))
        );
    }

    #[test]
    fn custom_destination_with_empty_template_targets_root() {
        let file = media(Path::new("/tmp/clip.mov"));
        let repository = Repository {
            repository_type: "local".into(),
            root: "/tmp/custom-target".into(),
            ..Repository::default()
        };
        let request = CopyRequest {
            source_uuid: "source".into(),
            destination_root: "/tmp/custom-target".into(),
            mode: "flat".into(),
            selection: crate::models::CopySelection {
                file_ids: vec!["media-1".into()],
                ..crate::models::CopySelection::default()
            },
            ..CopyRequest::default()
        };
        let task = build_task(&[file], &repository, &request).expect("task");
        assert_eq!(task.destination_root, "/tmp/custom-target");
        assert_eq!(task.files[0].relative, "clip.mov");
    }

    #[test]
    fn stale_executor_cannot_release_replacement_control() {
        let state = RuntimeState::new(crate::models::Catalog::default(), PathBuf::new());
        let first = Arc::new(AtomicBool::new(false));
        let replacement = Arc::new(AtomicBool::new(false));
        state
            .pauses
            .write()
            .expect("task controls")
            .insert("task".into(), first.clone());
        state
            .pauses
            .write()
            .expect("task controls")
            .insert("task".into(), replacement.clone());

        assert!(!owns_task_control(&state, "task", &first));
        assert!(owns_task_control(&state, "task", &replacement));
        release_task_control(&state, "task", &first);
        assert!(owns_task_control(&state, "task", &replacement));
    }

    #[test]
    fn entering_verification_reconciles_transfer_progress() {
        let mut task = CopyTask {
            total_bytes: 300,
            copied_bytes: 100,
            status: "running".into(),
            speed: 42.0,
            eta: Some(9),
            files: vec![
                CopyFileState {
                    size: 100,
                    copied: 100,
                    status: "copied".into(),
                    ..CopyFileState::default()
                },
                CopyFileState {
                    size: 200,
                    copied: 0,
                    status: "queued".into(),
                    ..CopyFileState::default()
                },
            ],
            ..CopyTask::default()
        };

        finish_transfer_phase(&mut task);

        assert_eq!(task.status, "verifying");
        assert_eq!(task.copied_bytes, task.total_bytes);
        assert!(task.files.iter().all(|file| file.copied == file.size));
        assert!(task.files.iter().all(|file| file.status == "copied"));
        assert_eq!(task.speed, 0.0);
        assert_eq!(task.eta, Some(0));
    }

    #[tokio::test]
    async fn local_copy_resumes_partial_file() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let source = temporary.path().join("source.mov");
        let destination = temporary.path().join("vault/clip.mov");
        let content = vec![3_u8; 2 * 1024 * 1024];
        std::fs::write(&source, &content).expect("source");
        std::fs::create_dir_all(destination.parent().expect("parent")).expect("destination parent");
        std::fs::write(
            format!("{}.material-gater.part", destination.to_string_lossy()),
            &content[..512 * 1024],
        )
        .expect("partial");
        let mut transferred = 0;
        copy_local_file(
            &source,
            &destination,
            &AtomicBool::new(false),
            |bytes, _| {
                transferred += bytes;
                Ok(())
            },
        )
        .await
        .expect("copy");
        assert_eq!(
            std::fs::metadata(destination).expect("destination").len(),
            content.len() as u64
        );
        assert_eq!(transferred, (content.len() - 512 * 1024) as u64);
    }

    #[tokio::test]
    async fn local_hash_matches_blake3_reference() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let source = temporary.path().join("clip.mov");
        let content = b"material-gater-integrity-check";
        std::fs::write(&source, content).expect("source");
        let hash = hash_local_file(&source, &AtomicBool::new(false), |_| Ok(()))
            .await
            .expect("hash");
        assert_eq!(hash, blake3::hash(content).to_hex().to_string());
    }
}
