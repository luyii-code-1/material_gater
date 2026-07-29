use crate::models::{FfmpegInfo, ThumbnailResult};
use crate::storage::RuntimeState;
use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
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
    let key = blake3::hash(format!("thumbnail-v3\0{source}").as_bytes())
        .to_hex()
        .to_string();
    cache_directory(state).join(format!("{key}.png"))
}

pub fn load(state: &RuntimeState, requested: &str) -> Result<String> {
    let directory = cache_directory(state)
        .canonicalize()
        .context("缩略图缓存目录不可用")?;
    let path = Path::new(requested)
        .canonicalize()
        .context("缩略图缓存不存在")?;
    anyhow::ensure!(
        path.starts_with(&directory),
        "拒绝读取缩略图缓存目录之外的文件"
    );
    let bytes = fs::read(&path).context("无法读取缩略图缓存")?;
    anyhow::ensure!(!bytes.is_empty(), "缩略图缓存为空");
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}

pub fn cleanup(state: &RuntimeState) -> Result<()> {
    let directory = cache_directory(state);
    fs::create_dir_all(&directory).context("无法创建缩略图缓存")?;
    for entry in fs::read_dir(&directory).context("无法读取缩略图缓存")? {
        let path = entry?.path();
        if path.is_file()
            && path
                .metadata()
                .map(|value| value.len() == 0)
                .unwrap_or(false)
        {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

fn ffmpeg_candidates(preferred: Option<&str>) -> Vec<PathBuf> {
    let executable = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let mut candidates = Vec::new();
    if let Some(value) = preferred.map(str::trim).filter(|value| !value.is_empty()) {
        candidates.push(PathBuf::from(value));
    }
    if let Some(paths) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&paths).map(|path| path.join(executable)));
    }
    #[cfg(target_os = "macos")]
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/ffmpeg"),
        PathBuf::from("/usr/local/bin/ffmpeg"),
        PathBuf::from("/opt/local/bin/ffmpeg"),
    ]);
    #[cfg(target_os = "windows")]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("Microsoft/WinGet/Links/ffmpeg.exe"));
    }
    let mut unique = Vec::new();
    for candidate in candidates {
        if !unique.contains(&candidate) {
            unique.push(candidate);
        }
    }
    unique
}

fn inspect_ffmpeg(path: &Path) -> Option<FfmpegInfo> {
    let output = Command::new(path).arg("-version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("FFmpeg")
        .trim()
        .to_string();
    Some(FfmpegInfo {
        path: path.to_string_lossy().into_owned(),
        version,
        valid: true,
    })
}

fn resolve_ffmpeg(preferred: Option<&str>) -> Option<FfmpegInfo> {
    ffmpeg_candidates(preferred)
        .into_iter()
        .find_map(|candidate| inspect_ffmpeg(&candidate))
}

pub fn detect_ffmpeg(state: &RuntimeState, preferred: Option<String>) -> FfmpegInfo {
    if let Some(value) = preferred
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return inspect_ffmpeg(Path::new(value)).unwrap_or_else(|| FfmpegInfo {
            path: value.to_string(),
            version: "无法执行该文件".into(),
            valid: false,
        });
    }
    let configured = state
        .catalog
        .read()
        .ok()
        .map(|catalog| catalog.settings.ffmpeg_path.clone())
        .unwrap_or_default();
    resolve_ffmpeg(Some(&configured)).unwrap_or(FfmpegInfo {
        path: String::new(),
        version: "未检测到 FFmpeg".into(),
        valid: false,
    })
}

fn cached_thumbnail_ready(path: &Path) -> bool {
    path.metadata()
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false)
}

fn video_thumbnail_ready(path: &Path) -> bool {
    path.metadata()
        .map(|metadata| metadata.len() > 512)
        .unwrap_or(false)
}

fn generate_video_attempt(
    ffmpeg: &Path,
    source: &Path,
    destination: &Path,
    seek: &str,
    seek_before_input: bool,
    representative_frame: bool,
) -> Result<()> {
    let _ = fs::remove_file(destination);
    let mut command = Command::new(ffmpeg);
    command.args(["-hide_banner", "-loglevel", "error", "-nostdin"]);
    if seek_before_input {
        command.args(["-ss", seek]);
    }
    command.arg("-i").arg(source);
    if !seek_before_input {
        command.args(["-ss", seek]);
    }
    let filter = if representative_frame {
        "thumbnail=24,scale=320:-2:force_original_aspect_ratio=decrease:flags=lanczos,format=rgb24"
    } else {
        "scale=320:-2:force_original_aspect_ratio=decrease:flags=lanczos,format=rgb24"
    };
    let status = command
        .args([
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-frames:v",
            "1",
            "-vf",
            filter,
            "-c:v",
            "png",
            "-pix_fmt",
            "rgb24",
            "-f",
            "image2",
            "-y",
        ])
        .arg(destination)
        .status()
        .context("无法调用 FFmpeg 视频解码器")?;
    if status.success() && video_thumbnail_ready(destination) {
        Ok(())
    } else {
        bail!("FFmpeg 无法解码该视频帧")
    }
}

fn generate_video(ffmpeg: &Path, source: &Path, destination: &Path) -> Result<()> {
    let attempts = [
        ("1", true, true),
        ("3", true, true),
        ("8", true, true),
        ("0", false, true),
        ("1", true, false),
        ("0", false, false),
    ];
    let mut last_error = None;
    for (seek, before_input, representative_frame) in attempts {
        match generate_video_attempt(
            ffmpeg,
            source,
            destination,
            seek,
            before_input,
            representative_frame,
        ) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
    }
    if let Some(error) = last_error {
        bail!("FFmpeg 无法生成可用视频缩略图：{error}")
    }
    bail!("FFmpeg 无法生成可用视频缩略图")
}

#[cfg(target_os = "macos")]
fn generate(source: &Path, destination: &Path, ffmpeg: Option<&Path>) -> Result<()> {
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

    if matches!(
        extension.as_str(),
        "mov" | "mp4" | "m4v" | "mxf" | "avi" | "mkv" | "r3d" | "braw"
    ) {
        let ffmpeg = ffmpeg.context("未找到可用的 FFmpeg 视频解码器")?;
        return generate_video(ffmpeg, source, destination);
    }

    bail!("该文件类型不支持缩略图")
}

#[cfg(target_os = "windows")]
fn generate(source: &Path, destination: &Path, ffmpeg: Option<&Path>) -> Result<()> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        extension.as_str(),
        "mov" | "mp4" | "m4v" | "mxf" | "avi" | "mkv" | "r3d" | "braw"
    ) {
        let ffmpeg = ffmpeg.context("未找到可用的 FFmpeg 视频解码器")?;
        return generate_video(ffmpeg, source, destination);
    }
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
fn generate(source: &Path, destination: &Path, ffmpeg: Option<&Path>) -> Result<()> {
    let ffmpeg = ffmpeg.context("未找到可用的 FFmpeg 视频解码器")?;
    generate_video(ffmpeg, source, destination)
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
        let mut failed = 0_u64;
        let mut ffmpeg_setting = String::new();
        let mut ffmpeg_path: Option<PathBuf> = None;
        let mut ffmpeg_resolved = false;
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
                    completed + failed,
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
            let processed = completed + failed;
            let total = processed
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
                processed,
                Some(total),
            );
            let destination = cache_path(&app.state::<RuntimeState>(), &source);
            let source_path = PathBuf::from(&source);
            let destination_for_worker = destination.clone();
            let configured = app
                .state::<RuntimeState>()
                .catalog
                .read()
                .ok()
                .map(|catalog| catalog.settings.ffmpeg_path.clone())
                .unwrap_or_default();
            if !ffmpeg_resolved || configured != ffmpeg_setting {
                ffmpeg_setting.clone_from(&configured);
                ffmpeg_path =
                    resolve_ffmpeg(Some(&configured)).map(|info| PathBuf::from(info.path));
                ffmpeg_resolved = true;
            }
            let ffmpeg = ffmpeg_path.clone();
            let generated = tauri::async_runtime::spawn_blocking(move || {
                generate(&source_path, &destination_for_worker, ffmpeg.as_deref())
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
            } else {
                failed += 1;
                let _ = app.emit(
                    "thumbnail-ready",
                    ThumbnailResult {
                        source,
                        cache_path: destination.to_string_lossy().into_owned(),
                        ready: false,
                    },
                );
            }
        }
        let processed = completed + failed;
        let detail = if failed > 0 {
            format!("已生成 {completed} 个缩略图，{failed} 个失败")
        } else {
            format!("已生成 {completed} 个缩略图")
        };
        crate::tasks::update(
            &app,
            &task.id,
            None,
            Some(detail.clone()),
            processed,
            Some(processed),
        );
        if failed > 0 {
            crate::tasks::fail(&app, &task.id, key, detail);
        } else {
            crate::tasks::complete(&app, &task.id, key);
        }
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
        let ready = cached_thumbnail_ready(&destination);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Catalog;

    #[test]
    fn loads_only_files_from_the_thumbnail_cache() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let state = RuntimeState::new(Catalog::default(), temporary.path().to_path_buf());
        cleanup(&state).expect("thumbnail cache");
        let cached = cache_directory(&state).join("sample.png");
        fs::write(&cached, b"png").expect("cached thumbnail");
        let outside = temporary.path().join("outside.png");
        fs::write(&outside, b"private").expect("outside file");

        assert_eq!(
            load(&state, cached.to_str().expect("cached path")).expect("data url"),
            "data:image/png;base64,cG5n"
        );
        assert!(load(&state, outside.to_str().expect("outside path")).is_err());
    }
}
