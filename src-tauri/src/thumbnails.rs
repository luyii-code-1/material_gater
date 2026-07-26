use crate::models::ThumbnailResult;
use crate::storage::RuntimeState;
use anyhow::{Context, Result, bail};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

fn cache_directory(state: &RuntimeState) -> PathBuf {
    state.data_dir.join("thumbnails")
}

fn cache_path(state: &RuntimeState, source: &str) -> PathBuf {
    let key = blake3::hash(source.as_bytes()).to_hex().to_string();
    cache_directory(state).join(format!("{key}.png"))
}

pub fn cleanup(state: &RuntimeState) -> Result<()> {
    let directory = cache_directory(state);
    if directory.exists() {
        fs::remove_dir_all(&directory).context("无法清理缩略图缓存")?;
    }
    fs::create_dir_all(directory).context("无法创建缩略图缓存")?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn generate(source: &Path, destination: &Path) -> Result<()> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        extension.as_str(),
        "jpg" | "jpeg" | "png" | "heic" | "heif" | "tif" | "tiff" | "dng"
    ) {
        let status = Command::new("/usr/bin/sips")
            .args(["-s", "format", "png", "-Z", "320"])
            .arg(source)
            .arg("--out")
            .arg(destination)
            .status()
            .context("无法调用系统图像服务")?;
        if status.success() && destination.is_file() {
            return Ok(());
        }
        bail!("系统无法生成该图片的缩略图");
    }

    if matches!(extension.as_str(), "mov" | "mp4" | "m4v" | "mxf") {
        let ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
            .into_iter()
            .map(Path::new)
            .find(|candidate| candidate.is_file())
            .context("未找到可用的视频缩略图服务")?;
        let status = Command::new(ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", "1"])
            .arg("-i")
            .arg(source)
            .args([
                "-frames:v",
                "1",
                "-vf",
                "scale=320:-2:force_original_aspect_ratio=decrease",
                "-y",
            ])
            .arg(destination)
            .status()
            .context("无法调用视频缩略图服务")?;
        if status.success() && destination.is_file() {
            return Ok(());
        }
        bail!("系统无法生成该视频的缩略图");
    }

    bail!("该文件类型不支持缩略图")
}

#[cfg(target_os = "windows")]
fn generate(source: &Path, destination: &Path) -> Result<()> {
    let script = r#"
param([string]$Source,[string]$Destination)
Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile($Source)
$thumb = $image.GetThumbnailImage(320,180,$null,[IntPtr]::Zero)
$thumb.Save($Destination,[System.Drawing.Imaging.ImageFormat]::Png)
$thumb.Dispose(); $image.Dispose()
"#;
    let status = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
            "-Source",
        ])
        .arg(source)
        .arg("-Destination")
        .arg(destination)
        .status()
        .context("无法调用 Windows 缩略图服务")?;
    if !status.success() {
        bail!("系统无法生成该文件的缩略图");
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn generate(_source: &Path, _destination: &Path) -> Result<()> {
    bail!("当前平台暂不支持系统缩略图")
}

fn start_worker(app: &AppHandle) {
    let state = app.state::<RuntimeState>();
    if state.thumbnail_worker.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let key = "thumbnail-worker";
        let Ok((task, _)) = crate::tasks::begin(
            &app,
            key,
            "thumbnail",
            "生成缩略图".into(),
            "等待系统空闲".into(),
        ) else {
            app.state::<RuntimeState>()
                .thumbnail_worker
                .store(false, Ordering::Release);
            return;
        };
        if let Ok(mut value) = app.state::<RuntimeState>().thumbnail_task.lock() {
            *value = Some(task.id.clone());
        }
        let mut completed = 0_u64;
        loop {
            if crate::tasks::checkpoint(&app, &task.id).is_err() {
                break;
            }
            while app
                .state::<RuntimeState>()
                .thumbnail_paused
                .load(Ordering::Relaxed)
            {
                crate::tasks::update(
                    &app,
                    &task.id,
                    None,
                    Some("检测到用户操作，等待空闲后继续".into()),
                    completed,
                    None,
                );
                tokio::time::sleep(Duration::from_millis(180)).await;
                if crate::tasks::checkpoint(&app, &task.id).is_err() {
                    break;
                }
            }
            let source = app
                .state::<RuntimeState>()
                .thumbnail_queue
                .lock()
                .ok()
                .and_then(|mut queue| queue.pop_front());
            let Some(source) = source else { break };
            let total = completed
                + 1
                + app
                    .state::<RuntimeState>()
                    .thumbnail_queue
                    .lock()
                    .map(|queue| queue.len() as u64)
                    .unwrap_or(0);
            crate::tasks::update(
                &app,
                &task.id,
                None,
                Some(
                    Path::new(&source)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                ),
                completed,
                Some(total),
            );
            let destination = cache_path(&app.state::<RuntimeState>(), &source);
            let source_path = PathBuf::from(&source);
            let destination_for_worker = destination.clone();
            let generated = tauri::async_runtime::spawn_blocking(move || {
                generate(&source_path, &destination_for_worker)
            })
            .await
            .ok()
            .and_then(Result::ok)
            .is_some();
            if let Ok(mut requested) = app.state::<RuntimeState>().thumbnail_requested.lock() {
                requested.remove(&source);
            }
            if generated {
                completed += 1;
                let _ = app.emit(
                    "thumbnail-ready",
                    ThumbnailResult {
                        source,
                        cache_path: destination.to_string_lossy().into_owned(),
                        ready: true,
                    },
                );
            }
        }
        crate::tasks::update(
            &app,
            &task.id,
            None,
            Some(format!("已生成 {completed} 个缩略图")),
            completed,
            Some(completed),
        );
        crate::tasks::complete(&app, &task.id, key);
        let state = app.state::<RuntimeState>();
        state.thumbnail_worker.store(false, Ordering::Release);
        if let Ok(mut value) = state.thumbnail_task.lock() {
            *value = None;
        }
        let has_more = state
            .thumbnail_queue
            .lock()
            .map(|queue| !queue.is_empty())
            .unwrap_or(false);
        if has_more {
            start_worker(&app);
        }
    });
}

pub fn request(app: &AppHandle, sources: Vec<String>) -> Result<Vec<ThumbnailResult>> {
    let state = app.state::<RuntimeState>();
    let mut results = Vec::with_capacity(sources.len());
    for source in sources.into_iter().take(500) {
        let path = Path::new(&source);
        if !path.is_absolute() || !path.is_file() {
            continue;
        }
        let destination = cache_path(&state, &source);
        let ready = destination.is_file();
        results.push(ThumbnailResult {
            source: source.clone(),
            cache_path: destination.to_string_lossy().into_owned(),
            ready,
        });
        if !ready {
            let mut requested = state
                .thumbnail_requested
                .lock()
                .map_err(|_| anyhow::anyhow!("缩略图队列锁已损坏"))?;
            if requested.insert(source.clone()) {
                state
                    .thumbnail_queue
                    .lock()
                    .map_err(|_| anyhow::anyhow!("缩略图队列锁已损坏"))?
                    .push_back(source);
            }
        }
    }
    start_worker(app);
    Ok(results)
}

pub fn set_user_active(state: &RuntimeState, active: bool) {
    state.thumbnail_paused.store(active, Ordering::Relaxed);
}
