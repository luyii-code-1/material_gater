use crate::models::{CopyFileState, CopyRequest, CopyTask, MediaFile, Repository};
use crate::repository::{copy_remote_fs, copy_smb};
use crate::storage::{RuntimeState, read_password, save_catalog};
use anyhow::{Context, Result, bail};
use chrono::{DateTime, Local, NaiveDate, Utc};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::fs::{self, File, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom};
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
        .replace_all(
            if template.trim().is_empty() {
                "%day/%note"
            } else {
                template
            },
            |captures: &regex::Captures<'_>| safe_segment(&captures[1]),
        )
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
        source_uuid: input.source_uuid.clone(),
        status: "queued".into(),
        total_bytes,
        copied_bytes: 0,
        speed: 0.0,
        eta: None,
        history: vec![],
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
        .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?;
    let task = catalog
        .tasks
        .iter()
        .find(|task| task.id == id)
        .cloned()
        .context("找不到拷贝任务")?;
    let repository = catalog
        .repositories
        .iter()
        .find(|repository| repository.id == task.repository_id)
        .cloned()
        .context("储存库已被删除")?;
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
            .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?;
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
        .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?
        .tasks
        .clone();
    let _ = app.emit("copy-changed", tasks);
    Ok(task)
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

async fn execute_local(
    app: &AppHandle,
    task: &CopyTask,
    repository: &Repository,
    pause: Arc<AtomicBool>,
) -> Result<()> {
    let mut window_bytes = 0_u64;
    let mut window_started = Instant::now();
    let mut last_update = Instant::now() - Duration::from_secs(1);
    for file in task.files.clone() {
        if file.status == "completed" {
            continue;
        }
        if pause.load(Ordering::Relaxed) {
            bail!("任务已暂停");
        }
        update_task(app, &task.id, |task| {
            if let Some(value) = task.files.iter_mut().find(|value| value.id == file.id) {
                value.status = "copying".into();
                value.error.clear();
            }
        })?;
        let destination = Path::new(&repository.root).join(safe_relative(&file.relative));
        let skipped = copy_local_file(
            Path::new(&file.source),
            &destination,
            &pause,
            |bytes, copied| {
                window_bytes += bytes;
                if last_update.elapsed() >= Duration::from_millis(450) || bytes == 0 {
                    let elapsed = window_started.elapsed().as_secs_f64().max(0.01);
                    let speed = window_bytes as f64 / elapsed;
                    update_task(app, &task.id, |task| {
                        if let Some(value) = task.files.iter_mut().find(|value| value.id == file.id)
                        {
                            value.copied = copied;
                        }
                        task.copied_bytes = task
                            .files
                            .iter()
                            .map(|value| value.copied.min(value.size))
                            .sum();
                        task.speed = speed;
                        task.eta = (speed > 0.0).then(|| {
                            ((task.total_bytes.saturating_sub(task.copied_bytes)) as f64 / speed)
                                .ceil() as u64
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
            },
        )
        .await?;
        update_task(app, &task.id, |task| {
            if let Some(value) = task.files.iter_mut().find(|value| value.id == file.id) {
                value.copied = value.size;
                value.status = "completed".into();
                value.error.clear();
            }
            task.copied_bytes = task
                .files
                .iter()
                .map(|value| value.copied.min(value.size))
                .sum();
            if skipped {
                task.speed = 0.0;
            }
        })?;
    }
    Ok(())
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

async fn execute_remote(
    app: &AppHandle,
    task: &CopyTask,
    repository: &Repository,
    password: &str,
    pause: Arc<AtomicBool>,
) -> Result<()> {
    for file in task.files.clone() {
        if file.status == "completed" {
            continue;
        }
        if pause.load(Ordering::Relaxed) {
            bail!("任务已暂停");
        }
        update_task(app, &task.id, |task| {
            if let Some(value) = task.files.iter_mut().find(|value| value.id == file.id) {
                value.status = "copying".into();
                value.error.clear();
            }
        })?;
        let progress = progress_reporter(app.clone(), task.id.clone(), file.id.clone());
        let skipped = match repository.repository_type.as_str() {
            "smb" => {
                copy_smb(
                    repository,
                    password,
                    Path::new(&file.source),
                    &file.relative,
                    pause.clone(),
                    progress,
                )
                .await?
            }
            "ftp" | "sftp" => {
                let repository = repository.clone();
                let password = password.to_string();
                let source = PathBuf::from(&file.source);
                let relative = file.relative.clone();
                let pause = pause.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    copy_remote_fs(&repository, &password, &source, &relative, pause, progress)
                })
                .await??
            }
            _ => bail!("不支持的远程储存库类型"),
        };
        update_task(app, &task.id, |task| {
            if let Some(value) = task.files.iter_mut().find(|value| value.id == file.id) {
                value.copied = value.size;
                value.status = "completed".into();
                value.error.clear();
            }
            task.copied_bytes = task
                .files
                .iter()
                .map(|value| value.copied.min(value.size))
                .sum();
            if skipped {
                task.speed = 0.0;
            }
        })?;
    }
    Ok(())
}

async fn execute_task(app: AppHandle, id: String, pause: Arc<AtomicBool>) {
    let state = app.state::<RuntimeState>();
    let Ok((task, repository)) = task_and_repository(&state, &id) else {
        let _ = update_task(&app, &id, |task| {
            task.status = "failed".into();
            task.error = "储存库已被删除".into();
        });
        return;
    };
    let password = read_password(&repository.id);
    let result = if repository.repository_type == "local" || !repository.root.is_empty() {
        execute_local(&app, &task, &repository, pause.clone()).await
    } else {
        execute_remote(&app, &task, &repository, &password, pause.clone()).await
    };
    match result {
        Ok(()) => {
            let _ = update_task(&app, &id, |task| {
                task.status = "completed".into();
                task.copied_bytes = task.total_bytes;
                task.speed = 0.0;
                task.eta = Some(0);
                task.error.clear();
            });
        }
        Err(_error) if pause.load(Ordering::Relaxed) => {
            let _ = update_task(&app, &id, |task| {
                task.status = "paused".into();
                task.speed = 0.0;
                task.error.clear();
                if let Some(file) = task.files.iter_mut().find(|file| file.status == "copying") {
                    file.status = "queued".into();
                }
            });
        }
        Err(error) => {
            let message = error.to_string();
            let _ = update_task(&app, &id, |task| {
                task.status = "failed".into();
                task.speed = 0.0;
                task.error = message.clone();
                if let Some(file) = task.files.iter_mut().find(|file| file.status == "copying") {
                    file.status = "failed".into();
                    file.error = message;
                }
            });
        }
    }
    state
        .pauses
        .write()
        .ok()
        .map(|mut values| values.remove(&id));
}

pub fn start_task(app: &AppHandle, id: &str) -> Result<()> {
    let state = app.state::<RuntimeState>();
    {
        let catalog = state
            .catalog
            .read()
            .map_err(|_| anyhow::anyhow!("素材库锁已损坏"))?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.id == id)
            .context("找不到拷贝任务")?;
        if task.status == "running" || task.status == "completed" {
            return Ok(());
        }
    }
    let pause = Arc::new(AtomicBool::new(false));
    state
        .pauses
        .write()
        .map_err(|_| anyhow::anyhow!("任务锁已损坏"))?
        .insert(id.into(), pause.clone());
    update_task(app, id, |task| {
        task.status = "running".into();
        task.error.clear();
        task.copied_bytes = task
            .files
            .iter()
            .map(|file| file.copied.min(file.size))
            .sum();
    })?;
    let app = app.clone();
    let id = id.to_string();
    tauri::async_runtime::spawn(execute_task(app, id, pause));
    Ok(())
}

pub fn pause_task(app: &AppHandle, id: &str) -> Result<()> {
    let state = app.state::<RuntimeState>();
    let pause = state
        .pauses
        .read()
        .map_err(|_| anyhow::anyhow!("任务锁已损坏"))?
        .get(id)
        .cloned();
    if let Some(pause) = pause {
        pause.store(true, Ordering::Relaxed);
    } else {
        update_task(app, id, |task| {
            if task.status != "completed" {
                task.status = "paused".into();
            }
        })?;
    }
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
}
